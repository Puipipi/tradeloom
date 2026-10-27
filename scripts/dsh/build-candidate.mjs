import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createReadStream, createWriteStream, realpath as realpathCallback } from 'node:fs'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { patchSetDigest, writeDesktopBuildReceipt } from '../../apps/tradeloom-launcher/receipt-writer.mjs'
import {
  runtimeMarkerContents,
  assertNoReparseAncestors,
  trustedReleaseRoot,
  validateOwnedRuntime,
} from '../../apps/tradeloom-launcher/prepare-profile.mjs'
import {
  assertDesktopDevelopmentProjectReady,
  assertTradeLoomDesktopAppIdentity,
} from '../../apps/tradeloom-launcher/desktop-receipt.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workspaceRoot = path.dirname(repoRoot)
const lockPath = path.join(repoRoot, 'integrations/dsh/patches/patches.lock.json')
const patchRoot = path.join(repoRoot, 'integrations/dsh/patches')
const realpath = promisify(realpathCallback.native)
const prospectiveSets = [
  {
    directory: 'v2-24',
    lockSha256: '1f4834f8a84bfb733b967916cfd5fb5492afdeafae9d36bc737913b50bb6ee51',
    orderSha256: '783cc93af8aaaaa514f18a9017b5c5405ad0c1197addabe850c4609fe35cdda1',
    patchSetSha256: 'a3ba866314fbcab9b87916d75dd416916987a46a413776d8955e3dbb798f988a',
  },
  {
    directory: 'v3-25',
    lockSha256: '31c63c81bd4bf3adae868e0d6e173bf36b5c4c54e288f424c3dfd693bfab65bf',
    orderSha256: '4555a7185ef1b08b7584974c1e27879df5ec0db2789848ba9e017aa58933cadd',
    patchSetSha256: '6b9288b465d073ca5da4a049f1ad5f5c81fb7e57017d8ec4f8b012e6c54e5047',
  },
  { directory: 'v4-26', lockSha256: '5e9e6180601e2b6231ce1c28aac02d17632fed6aad5a39094ec6af783cbc94c2', orderSha256: '3d880cebc6689e43c6ab596a441634affb156090efba6c420f76518217abeac4', patchSetSha256: '37a81064e95c51a11711c5a871f6e5f02858dad03b6abb40604c01f3cb2a0dac' },
  { directory: 'patch-set-27', lockSha256: '0376bad0288ff90a944fd94b90596328a73cfe449ccc2faf1fe2682b50c51c2f', orderSha256: 'e20f845702006c17bf2bce647a62567230f418b3fd0ab1e51e8b5ca678a5384b', patchSetSha256: '43f84209c8d607b19cf4c3e113c2a9e2e43f551b18affcc3a924baf6c4b74e1e' },
  { directory: 'patch-set-28', lockSha256: '710c76095935fcc1844d29870cd201f1cf098f262f0ef30da6ab9aa5d242520c', orderSha256: '86585366b268fc7f2f8fa5589e36e7f73c7f9460affc9b14f0b745c8b04401db', patchSetSha256: '24df3fb1f12e7d4179b9a4e69a928d368da5a28b0ae99137a190b0f886f4c39f' },
  { directory: 'patch-set-29', lockSha256: 'f7c1e3a8cd79729695f48090daae03bfa929ee2477e0711cb635d3ba31932eb4', orderSha256: '8ed49e1ad1988da93f507377fbc5f8ad02ca15fad47282829480424cb589bd05', patchSetSha256: 'af43ce97603d8f5a1549d50ffedaacb4053cf3937b4a1e1a36f08e75f3d43141' },
  { directory: 'patch-set-32', lockSha256: 'fbf76ea942fd87debcf89ff7e27fa559d86cdd0b90232663ab38e1558c81a9cb', orderSha256: 'e3ec3d709d902991f5fccf53435d8ed1bc4b83b0f573cb0c2b0dba1a317243ff', patchSetSha256: 'cb41ab81d89d77346deb6e653aaa8ea9f6f3c5ec2fe8a4c051cd77d506445a2b' },
  { directory: 'patch-set-33', lockSha256: '19cde34c354166c17f8997acba20c76452ae2d1c9fd7c5b96118ed486b6ac874', orderSha256: 'a465752afb9ee874e98f3e0123bfa01ed36bae9041124e2fd9acbe995f0c565c', patchSetSha256: '77587f7e7c9b8a7fc1969e4e6b4225d000d4e847d483bacfe3174931648aa322' },
  { directory: 'patch-set-33-exit', lockSha256: '848409e5579e83d3760e07b0975f5a2dae3d4b09b4b856eedd0a64a383b2c94c', orderSha256: 'a465752afb9ee874e98f3e0123bfa01ed36bae9041124e2fd9acbe995f0c565c', patchSetSha256: '1de9ca2954620b29afe561cd24eeb9bab99f7d305f43f49064b3cca7a7d9bece' },
  { directory: 'repo-desktop24-exit', lockSha256: '848409e5579e83d3760e07b0975f5a2dae3d4b09b4b856eedd0a64a383b2c94c', orderSha256: 'a465752afb9ee874e98f3e0123bfa01ed36bae9041124e2fd9acbe995f0c565c', patchSetSha256: '1de9ca2954620b29afe561cd24eeb9bab99f7d305f43f49064b3cca7a7d9bece' },
].map(set => ({
  ...set,
  root: set.directory === 'repo-desktop24-exit'
    ? path.join(repoRoot, 'integrations/dsh/prospective/desktop24-exit')
    : set.directory === 'patch-set-33-exit'
    ? path.join(workspaceRoot, 'workspace/testing/desktop24-exit-fix-build-20261027/patch-set-33-exit')
    : set.directory === 'patch-set-33'
    ? path.join(workspaceRoot, 'workspace/testing/native-file-applications-policy-20261027/patch-set-33')
    : set.directory === 'patch-set-32'
    ? path.join(workspaceRoot, 'workspace/testing/native-file-applications-policy-20261027/patch-set-32')
    : set.directory === 'patch-set-29'
    ? path.join(workspaceRoot, 'workspace/testing/native-file-applications-policy-20261027/patch-set-29')
    : set.directory === 'patch-set-28'
    ? path.join(workspaceRoot, 'workspace/testing/frontend-visual-fixes-20261025/batch66-native-runtime28/patch-set-28')
    : set.directory === 'patch-set-27'
    ? path.join(workspaceRoot, 'workspace/testing/frontend-visual-fixes-20261025/batch46-menu-runtime-source/patch-set-27')
    : path.join(workspaceRoot, 'workspace/testing/frontend-visual-fixes-20261025/batch16-native-preflight', set.directory),
}))
const scriptPath = fileURLToPath(import.meta.url)
let activeEvidenceDir
let activeIdentity
let activeDescriptorCreated = false
let activeReceiptCreated = false

function isWithinDirectory(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export async function resolveRuntimeTsxCli(runtimePath) {
  const runtime = await realpath(path.resolve(runtimePath))
  const nodeModulesPath = path.join(runtime, 'node_modules')
  const storePath = path.join(nodeModulesPath, '.pnpm')
  for (const directory of [nodeModulesPath, storePath]) {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`candidate runtime TSX dependency path must be an ordinary directory: ${directory}`)
    }
    const canonical = await realpath(directory)
    if (!isWithinDirectory(runtime, canonical)) {
      throw new Error(`candidate runtime TSX dependency path escaped its runtime: ${directory}`)
    }
  }
  const store = await realpath(storePath)
  const packageRoot = await realpath(path.join(nodeModulesPath, 'tsx'))
  if (!isWithinDirectory(store, packageRoot)) throw new Error('candidate runtime TSX package escaped node_modules/.pnpm.')
  const packageRelative = path.relative(store, packageRoot).split(path.sep)
  if (packageRelative.length !== 3 || packageRelative[1] !== 'node_modules' || packageRelative[2] !== 'tsx') {
    throw new Error('candidate runtime TSX package did not resolve to its canonical pnpm package directory.')
  }
  const packageManifestPath = path.join(packageRoot, 'package.json')
  const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8'))
  const storeEntryPrefix = `tsx@${packageManifest.version}`
  if (packageManifest.name !== 'tsx' || typeof packageManifest.version !== 'string' || !packageManifest.version
    || /[\\/]/.test(packageManifest.version)
    || (packageRelative[0] !== storeEntryPrefix
      && (!packageRelative[0].startsWith(`${storeEntryPrefix}_`) || packageRelative[0].length === storeEntryPrefix.length + 1))) {
    throw new Error(`candidate runtime TSX package metadata does not match its pnpm store entry: ${packageRelative[0]}`)
  }
  const cliRelative = typeof packageManifest.bin === 'string' ? packageManifest.bin : packageManifest.bin?.tsx
  if (typeof cliRelative !== 'string' || path.isAbsolute(cliRelative)
    || cliRelative.split(/[\\/]/).some(segment => segment === '..' || segment === '')) {
    throw new Error('candidate runtime TSX package has an unsafe or missing CLI entry.')
  }
  const cliPath = path.resolve(packageRoot, cliRelative)
  if (!isWithinDirectory(packageRoot, cliPath)) throw new Error('candidate runtime TSX CLI escaped its package directory.')
  const canonicalCliPath = await realpath(cliPath)
  const cliInfo = await lstat(cliPath)
  if (!cliInfo.isFile() || !isWithinDirectory(packageRoot, canonicalCliPath)) {
    throw new Error('candidate runtime TSX CLI must be a file inside its canonical package directory.')
  }
  return canonicalCliPath
}

export async function runtimeTsxInvocation(runtimePath, args) {
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('runtime TSX arguments must be an array of strings.')
  }
  return { command: process.execPath, args: [await resolveRuntimeTsxCli(runtimePath), ...args] }
}

export function usesInstalledPnpm(prospectiveSetDirectory) {
  return prospectiveSetDirectory === 'v3-25' || prospectiveSetDirectory === 'v4-26' || prospectiveSetDirectory === 'patch-set-27' || prospectiveSetDirectory === 'patch-set-28' || prospectiveSetDirectory === 'patch-set-29' || prospectiveSetDirectory === 'patch-set-32' || prospectiveSetDirectory === 'patch-set-33' || prospectiveSetDirectory === 'patch-set-33-exit' || prospectiveSetDirectory === 'repo-desktop24-exit'
}

export async function resolveRuntimePnpmCli(runtimePath) {
  const runtime = await realpath(path.resolve(runtimePath))
  const nodeModulesPath = path.join(runtime, 'node_modules')
  const storePath = path.join(nodeModulesPath, '.pnpm')
  for (const directory of [nodeModulesPath, storePath]) {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`candidate runtime pnpm dependency path must be an ordinary directory: ${directory}`)
    }
    const canonical = await realpath(directory)
    if (!isWithinDirectory(runtime, canonical)) {
      throw new Error(`candidate runtime pnpm dependency path escaped its runtime: ${directory}`)
    }
  }
  const store = await realpath(storePath)
  const rootManifest = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'))
  const pinnedVersion = /^pnpm@(\d+\.\d+\.\d+)$/.exec(rootManifest.packageManager ?? '')?.[1]
  if (!pinnedVersion) throw new Error('candidate runtime packageManager must pin pnpm to an exact version.')

  const packageRoot = await realpath(path.join(nodeModulesPath, 'pnpm'))
  if (!isWithinDirectory(store, packageRoot)) throw new Error('candidate runtime pnpm package escaped node_modules/.pnpm.')
  const packageRelative = path.relative(store, packageRoot).split(path.sep)
  if (packageRelative.length !== 3 || packageRelative[0] !== `pnpm@${pinnedVersion}`
    || packageRelative[1] !== 'node_modules' || packageRelative[2] !== 'pnpm') {
    throw new Error('candidate runtime pnpm package did not resolve to its pinned canonical pnpm package directory.')
  }
  const packageManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  if (packageManifest.name !== 'pnpm' || packageManifest.version !== pinnedVersion) {
    throw new Error('candidate runtime pnpm package does not match the root packageManager pin.')
  }
  const cliRelative = typeof packageManifest.bin === 'string' ? packageManifest.bin : packageManifest.bin?.pnpm
  if (typeof cliRelative !== 'string' || path.isAbsolute(cliRelative)
    || cliRelative.split(/[\\/]/).some(segment => segment === '..' || segment === '')) {
    throw new Error('candidate runtime pnpm package has an unsafe or missing CLI entry.')
  }
  const cliPath = path.resolve(packageRoot, cliRelative)
  if (!isWithinDirectory(packageRoot, cliPath)) throw new Error('candidate runtime pnpm CLI escaped its package directory.')
  const canonicalCliPath = await realpath(cliPath)
  const cliInfo = await lstat(cliPath)
  if (!cliInfo.isFile() || !isWithinDirectory(packageRoot, canonicalCliPath)) {
    throw new Error('candidate runtime pnpm CLI must be a file inside its canonical package directory.')
  }
  return canonicalCliPath
}

export async function runtimePnpmInvocation(runtimePath, args) {
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('runtime pnpm arguments must be an array of strings.')
  }
  return { command: process.execPath, args: [await resolveRuntimePnpmCli(runtimePath), ...args] }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(filePath)
    input.on('error', reject)
    input.on('data', chunk => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

function safeRelativeTarget(relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
    || relative.includes('\\') || relative.includes(':') || relative.includes('\0')) return false
  return relative.split('/').every(segment => segment && segment !== '.' && segment !== '..'
    && !segment.endsWith('.') && !segment.endsWith(' ')
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(segment)
    && !/[<>:"|?*\x00-\x1f]/.test(segment))
}

async function ordinaryFile(filePath, stopAt) {
  await assertNoReparseAncestors(filePath, stopAt)
  const info = await lstat(filePath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`prospective input must be an ordinary file: ${filePath}`)
}

async function resolvePatchConfiguration(values) {
  const supplied = [values['prospective-lock-path'], values['patch-root'], values['patch-order']]
  const count = supplied.filter(value => value !== undefined).length
  if (count !== 0 && (count !== 3 || supplied.some(value => typeof value !== 'string' || value.trim() === ''))) {
    throw new Error('--prospective-lock-path, --patch-root and --patch-order must be supplied together with non-blank values.')
  }
  if (count === 0) {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    return { lock, lockPath, patchRoot, patchOrder: undefined, lockSha256: await sha256File(lockPath), orderSha256: undefined }
  }

  const prospectiveLockPath = path.resolve(values['prospective-lock-path'])
  const selectedPatchRoot = path.resolve(values['patch-root'])
  const patchOrderPath = path.resolve(values['patch-order'])
  const approvedSet = prospectiveSets.find(set =>
    prospectiveLockPath.toLowerCase() === path.join(set.root, 'patches.prospective.lock.json').toLowerCase()
    && patchOrderPath.toLowerCase() === path.join(set.root, 'order.prospective.json').toLowerCase())
  if (!path.isAbsolute(values['prospective-lock-path']) || !path.isAbsolute(values['patch-root'])
    || !path.isAbsolute(values['patch-order'])
    || !approvedSet
    || selectedPatchRoot.toLowerCase() !== (approvedSet?.directory === 'repo-desktop24-exit' ? path.join(approvedSet.root, 'patches') : patchRoot).toLowerCase()) {
    throw new Error('Prospective paths must name an approved v2-24, v3-25, v4-26, patch-set-27, patch-set-28, patch-set-29, patch-set-32 or patch-set-33 lock/order and repository patch root.')
  }
  await ordinaryFile(prospectiveLockPath, workspaceRoot)
  await ordinaryFile(patchOrderPath, workspaceRoot)
  await assertNoReparseAncestors(selectedPatchRoot, repoRoot)
  const lockSha256 = await sha256File(prospectiveLockPath)
  const orderSha256 = await sha256File(patchOrderPath)
  if (lockSha256 !== approvedSet.lockSha256 || orderSha256 !== approvedSet.orderSha256) {
    throw new Error(`Prospective lock/order digest does not match the reviewed ${approvedSet.directory} inputs.`)
  }
  const lock = JSON.parse(await readFile(prospectiveLockPath, 'utf8'))
  const orderDocument = JSON.parse(await readFile(patchOrderPath, 'utf8'))
  const patchOrder = orderDocument.order
  const lockedNames = Object.keys(lock.patches ?? {})
  if (!Array.isArray(patchOrder) || patchOrder.length !== lockedNames.length
    || new Set(patchOrder).size !== patchOrder.length
    || patchOrder.some(name => typeof name !== 'string' || !/^[A-Za-z0-9._-]+\.patch$/.test(name))
    || [...lockedNames].some(name => !patchOrder.includes(name))) {
    throw new Error('Prospective patch order does not exactly match the patch lock set.')
  }
  if (lock.upstream?.commit !== '1f81c047fc48fa190a683e469daa699857e9afe8'
    || lock.upstream?.licenseSha256 !== 'EBB4F09972AEE8608BE255DEBAF78451A68E95C290F55C240DEC2ECFA16EA6BE'
    || patchSetDigest(lock.patches) !== approvedSet.patchSetSha256) {
    throw new Error('Prospective patch lock must retain the reviewed RC3 pin, license and patchSet digest.')
  }
  for (const [relative, expected] of Object.entries(lock.targetFiles ?? {})) {
    if (!safeRelativeTarget(relative) || !/^[a-f0-9]{64}$/i.test(expected?.baseSha256 ?? '')
      || !/^[a-f0-9]{64}$/i.test(expected?.newSha256 ?? '')) {
      throw new Error(`Prospective lock has an unsafe target or invalid base/output hash: ${relative}`)
    }
  }
  for (const name of patchOrder) {
    const patchPath = path.join(selectedPatchRoot, name)
    await ordinaryFile(patchPath, repoRoot)
    if ((await sha256File(patchPath)).toLowerCase() !== String(lock.patches[name]).toLowerCase()) {
      throw new Error(`Prospective patch hash mismatch: ${name}`)
    }
  }
  return { lock, lockPath: prospectiveLockPath, patchRoot: selectedPatchRoot, patchOrder, lockSha256, orderSha256,
    prospectiveSetDirectory: approvedSet.directory }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

async function findSuccessfulBuildEvidence(evidenceRoot, identity) {
  const { readdir } = await import('node:fs/promises')
  const candidates = (await readdir(evidenceRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith(`build-${path.basename(identity.runtimePath)}-`))
    .map(entry => path.join(evidenceRoot, entry.name))
    .sort((left, right) => right.localeCompare(left))
  const requiredStages = ['build-lib', 'build-web', 'build-desktop', 'prepare-primary-runtime']
  for (const directory of candidates) {
    let run
    try { run = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8')) } catch { continue }
    if (run.runtimePath !== identity.runtimePath || run.sourceCommit !== identity.sourceCommit
      || run.candidateHead !== identity.candidateHead || run.patchSetSha256 !== identity.patchSetSha256
      || run.repositoryHead !== identity.repositoryHead || run.repositoryStatusSha256 !== identity.repositoryStatusSha256
      || (identity.prospectiveLockSha256 !== undefined && run.prospectiveLockSha256 !== identity.prospectiveLockSha256)
      || (identity.prospectiveOrderSha256 !== undefined && run.prospectiveOrderSha256 !== identity.prospectiveOrderSha256)
      || run.packageManagerMode !== identity.packageManagerMode
      || run.primaryRuntimeSmokeMode !== identity.primaryRuntimeSmokeMode) continue
    const phases = []
    let valid = true
    for (const id of requiredStages) {
      const stageDir = path.join(directory, id)
      try {
        const resultPath = path.join(stageDir, 'result.json')
        const result = JSON.parse(await readFile(resultPath, 'utf8'))
        const stdoutPath = path.join(stageDir, 'stdout.log')
        const stderrPath = path.join(stageDir, 'stderr.log')
        if (result.exitCode !== 0 || await sha256File(stdoutPath) !== result.stdoutSha256
          || await sha256File(stderrPath) !== result.stderrSha256) {
          valid = false
          break
        }
        phases.push({ id, exitCode: result.exitCode, runPath: path.join(stageDir, 'run.json'), resultPath, reused: true })
      } catch {
        valid = false
        break
      }
    }
    if (valid) return { runId: run.runId, phases }
  }
  return undefined
}

async function readReusableBuildEvidence(evidenceDir, evidenceRoot, identity) {
  const candidate = path.resolve(evidenceDir)
  const relative = path.relative(path.resolve(evidenceRoot), candidate)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !path.basename(candidate).startsWith(`build-${path.basename(identity.runtimePath)}-`)) {
    throw new Error('resume evidence must be a build run for this runtime inside the owned evidence directory.')
  }
  const info = await lstat(candidate)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('resume evidence must be an ordinary owned directory.')
  const run = JSON.parse(await readFile(path.join(candidate, 'run.json'), 'utf8'))
  if (run.runtimePath !== identity.runtimePath || run.sourceCommit !== identity.sourceCommit
    || run.candidateHead !== identity.candidateHead || run.patchSetSha256 !== identity.patchSetSha256
    || (identity.prospectiveLockSha256 !== undefined && run.prospectiveLockSha256 !== identity.prospectiveLockSha256)
    || (identity.prospectiveOrderSha256 !== undefined && run.prospectiveOrderSha256 !== identity.prospectiveOrderSha256)
    || run.repositoryHead !== identity.repositoryHead || run.packageManagerMode !== identity.packageManagerMode
    || run.primaryRuntimeSmokeMode !== identity.primaryRuntimeSmokeMode) {
    throw new Error('resume build evidence identity does not match this runtime, source, patch set and smoke policy.')
  }
  const phases = []
  for (const id of ['build-lib', 'build-web', 'build-desktop']) {
    const stageDir = path.join(candidate, id)
    const resultPath = path.join(stageDir, 'result.json')
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    const stdoutPath = path.join(stageDir, 'stdout.log')
    const stderrPath = path.join(stageDir, 'stderr.log')
    if (result.exitCode !== 0 || await sha256File(stdoutPath) !== result.stdoutSha256
      || await sha256File(stderrPath) !== result.stderrSha256) {
      throw new Error(`resume build evidence ${id} is incomplete or failed integrity checks.`)
    }
    phases.push({ id, exitCode: result.exitCode, runPath: path.join(stageDir, 'run.json'), resultPath, reused: true })
  }
  return { runId: run.runId, phases }
}

function descriptorPreparationSource(runtime) {
  return `import { execFileSync } from 'node:child_process'\n`
    + `import { createRequire } from 'node:module'\n`
    + `import { readFile } from 'node:fs/promises'\n`
    + `import path from 'node:path'\n`
    + `import { pathToFileURL } from 'node:url'\n`
    + `const runtime = ${JSON.stringify(runtime)}\n`
    + `const desktopRoot = path.join(runtime, 'apps/desktop')\n`
    + `const development = await import(pathToFileURL(path.join(desktopRoot, 'scripts/development-project.ts')).href)\n`
    + `const buildPaths = await import(pathToFileURL(path.join(desktopRoot, 'scripts/desktop-build-paths.mjs')).href)\n`
    + `const hostProtocol = await import(pathToFileURL(path.join(desktopRoot, 'src/host-protocol.ts')).href)\n`
    + `const electronPath = createRequire(path.join(desktopRoot, 'scripts/dev.ts'))('electron')\n`
    + `const nodeVersion = execFileSync(electronPath, ['-p', 'process.versions.node'], { cwd: desktopRoot, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim()\n`
    + `const desktop = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'))\n`
    + `const pnpm = JSON.parse(await readFile(path.join(runtime, 'node_modules/pnpm/package.json'), 'utf8'))\n`
    + `const projectDir = path.join(desktopRoot, '.desktop-build/development/project')\n`
    + `const preparedProjectDir = development.prepareDevelopmentProject({ projectDir, cliDir: path.join(runtime, 'apps/cli'), hostDir: path.join(runtime, 'apps/desktop-host'), dependencyDir: path.join(runtime, 'node_modules/.pnpm/node_modules'), release: { schemaVersion: 1, version: desktop.version, hostProtocolVersion: hostProtocol.DESKTOP_HOST_PROTOCOL_VERSION, nodeVersion, pnpmVersion: pnpm.version }, target: buildPaths.resolveDesktopBuildTarget() })\n`
    + `console.log(JSON.stringify({ projectDir: preparedProjectDir }))\n`
}

function primaryRuntimePreparationSource(runtime) {
  return `import { readFile } from 'node:fs/promises'\n`
    + `import path from 'node:path'\n`
    + `import { pathToFileURL } from 'node:url'\n`
    + `const runtime = ${JSON.stringify(runtime)}\n`
    + `const prepare = await import(pathToFileURL(path.join(runtime, 'scripts/primary-runtime/prepare.ts')).href)\n`
  + `const paths = await import(pathToFileURL(path.join(runtime, 'apps/desktop/scripts/desktop-build-paths.mjs')).href)\n`
    + `const root = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'))\n`
  + `const target = paths.desktopTargetBuildPaths('win-x64')\n`
  + `await prepare.preparePrimaryRuntime({ target: 'win-x64', output: target.runtime, cache: target.downloads, version: root.version })\n`
  + `console.log(JSON.stringify({ status: 'assembled', officialApi: 'preparePrimaryRuntime', output: target.runtime, smokeSkipped: 'user-request' }))\n`
}

function parseRuntimeArgument() {
  const { values, positionals } = parseArgs({
    options: { runtime: { type: 'string' }, 'skip-primary-runtime-smoke': { type: 'boolean', default: false },
      'resume-build-evidence': { type: 'string' }, 'prospective-lock-path': { type: 'string' },
      'patch-root': { type: 'string' }, 'patch-order': { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length || typeof values.runtime !== 'string' || !path.isAbsolute(values.runtime)) {
    throw new Error('用法：node scripts/dsh/build-candidate.mjs --runtime <绝对runtime路径> [--skip-primary-runtime-smoke] [--resume-build-evidence <本项目evidence目录>] [--prospective-lock-path <锁文件> --patch-root <补丁目录> --patch-order <顺序文件>]')
  }
  if (values['resume-build-evidence'] !== undefined && !path.isAbsolute(values['resume-build-evidence'])) {
    throw new Error('--resume-build-evidence must be an absolute evidence path.')
  }
  return { runtimePath: path.resolve(values.runtime), skipPrimaryRuntimeSmoke: values['skip-primary-runtime-smoke'],
    resumeBuildEvidence: values['resume-build-evidence'] === undefined ? undefined : path.resolve(values['resume-build-evidence']),
    values }
}

async function runCommand({ id, command, args, cwd, evidenceDir, identity }) {
  const startedAtUtc = new Date().toISOString()
  const stageDir = path.join(evidenceDir, id)
  await mkdir(stageDir, { recursive: false })
  const stdoutPath = path.join(stageDir, 'stdout.log')
  const stderrPath = path.join(stageDir, 'stderr.log')
  const runPath = path.join(stageDir, 'run.json')
  const resultPath = path.join(stageDir, 'result.json')
  const run = {
    schemaVersion: 1,
    id,
    startedAtUtc,
    command: [command, ...args],
    cwd,
    ...identity,
    stdoutPath,
    stderrPath,
  }
  await writeJson(runPath, run)

  const stdout = createWriteStream(stdoutPath, { flags: 'wx' })
  const stderr = createWriteStream(stderrPath, { flags: 'wx' })
  let spawnError
  let child
  let exitCode
  try {
    child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(stdout)
    child.stderr.pipe(stderr)
    exitCode = await new Promise(resolve => {
    child.once('error', error => {
      spawnError = error instanceof Error ? error.message : String(error)
      resolve(127)
    })
    child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 1)))
    })
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error)
    exitCode = 127
    stdout.end()
    stderr.end()
  }

  if (child) {
    child.stdout.unpipe(stdout)
    child.stderr.unpipe(stderr)
  }
  stdout.end()
  stderr.end()
  await Promise.all([finished(stdout), finished(stderr)])
  const result = {
    schemaVersion: 1,
    id,
    finishedAtUtc: new Date().toISOString(),
    exitCode,
    ...(spawnError ? { spawnError } : {}),
    stdoutSha256: await sha256File(stdoutPath),
    stderrSha256: await sha256File(stderrPath),
  }
  await writeJson(resultPath, result)
  return { exitCode, runPath, resultPath, stdoutPath, stderrPath, result }
}

async function main() {
  const { runtimePath, skipPrimaryRuntimeSmoke, resumeBuildEvidence, values } = parseRuntimeArgument()
  const patchConfiguration = await resolvePatchConfiguration(values)
  const { lock, lockPath: selectedLockPath, patchRoot: selectedPatchRoot, patchOrder, lockSha256, orderSha256 } = patchConfiguration
  const useInstalledPnpm = usesInstalledPnpm(patchConfiguration.prospectiveSetDirectory)
  const runtime = await validateOwnedRuntime(runtimePath, trustedReleaseRoot)
  if (await readFile(path.join(runtime, '.tradeloom-runtime-owned'), 'utf8') !== runtimeMarkerContents) {
    throw new Error('runtime ownership marker 与当前单 pin 不匹配。')
  }
  const existingReceipt = await lstat(path.join(runtime, '.tradeloom-desktop-build-receipt.json'))
    .then(() => true)
    .catch(error => {
      if (error.code === 'ENOENT') return false
      throw error
    })
  if (existingReceipt) throw new Error('candidate runtime 已有构建 receipt；拒绝覆盖。')
  const patchDigest = patchSetDigest(lock.patches)
  if (lock.upstream?.commit !== '1f81c047fc48fa190a683e469daa699857e9afe8') {
    throw new Error('patch lock 不再指向已审阅的 RC3 pin。')
  }
  const upstreamHead = execFileSync('git', ['-C', runtime, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (upstreamHead !== lock.upstream.commit) throw new Error('candidate runtime HEAD 与 patch lock pin 不匹配。')
  const repoHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const repoStatus = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
  const repoDiffSha256 = sha256(Buffer.from(repoStatus, 'utf8'))
  const patchNames = patchOrder ?? Object.keys(lock.patches).sort()
  const packageManagerPin = useInstalledPnpm
    ? JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8')).packageManager
    : undefined
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replaceAll('.', '')
  const runId = `${path.basename(runtime)}-${timestamp}-${process.pid}`
  const evidenceRoot = path.join(workspaceRoot, 'workspace/runtime/tradeloom-harness/evidence')
  await mkdir(evidenceRoot, { recursive: true })
  const evidenceDir = path.join(evidenceRoot, `build-${runId}`)
  await mkdir(evidenceDir, { recursive: false })
  const identity = {
    runId,
    runtimePath: runtime,
    sourceCommit: lock.upstream.commit,
    candidateHead: upstreamHead,
    repositoryHead: repoHead,
    repositoryStatusSha256: repoDiffSha256,
    patchSetSha256: patchDigest,
    patchCount: patchNames.length,
    primaryRuntimeSmokeMode: skipPrimaryRuntimeSmoke ? 'skipped-user-request' : 'official-smoke',
    ...(useInstalledPnpm ? { packageManagerMode: `runtime-local-${String(packageManagerPin)}` } : {}),
    ...(patchOrder === undefined ? {} : {
      prospectiveLockPath: path.relative(repoRoot, selectedLockPath).replaceAll('\\', '/'),
      prospectivePatchRoot: path.relative(repoRoot, selectedPatchRoot).replaceAll('\\', '/'),
      prospectiveOrderPath: path.relative(repoRoot, values['patch-order']).replaceAll('\\', '/'),
      prospectiveLockSha256: lockSha256,
      prospectiveOrderSha256: orderSha256,
    }),
  }
  const priorBuild = await findSuccessfulBuildEvidence(evidenceRoot, identity)
  const explicitResume = priorBuild ? undefined
    : resumeBuildEvidence ? await readReusableBuildEvidence(resumeBuildEvidence, evidenceRoot, identity) : undefined
  const reusableBuild = priorBuild ?? explicitResume
  activeEvidenceDir = evidenceDir
  activeIdentity = identity
  await writeJson(path.join(evidenceDir, 'run.json'), {
    schemaVersion: 1,
    startedAtUtc: new Date().toISOString(),
    ...identity,
    builder: path.relative(repoRoot, scriptPath).replaceAll('\\', '/'),
    phases: ['preflight', 'build-lib', 'build-web', 'build-desktop', 'prepare-primary-runtime', 'descriptor-and-receipt'],
    ...(reusableBuild ? { resumedBuildEvidence: reusableBuild.runId } : {}),
  })

  const preflight = await runCommand({
    id: 'preflight',
    command: 'pwsh.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      path.join(repoRoot, 'scripts/dsh/check-upstream.ps1'), '-RuntimePath', runtime,
      ...(patchOrder === undefined ? [] : ['-ProspectiveLockPath', selectedLockPath, '-PatchRoot', selectedPatchRoot, '-PatchOrder', values['patch-order']])],
    cwd: repoRoot,
    evidenceDir,
    identity,
  })
  if (preflight.exitCode !== 0) throw new Error(`RC3 patch/source preflight failed with exit ${preflight.exitCode}; see external evidence.`)

  const phaseResults = reusableBuild?.phases ?? []
  if (!reusableBuild) {
    for (const phase of [
      { id: 'build-lib', script: 'build:lib' },
      { id: 'build-web', script: 'build:web' },
      { id: 'build-desktop', script: 'build:desktop' },
    ]) {
      const invocation = useInstalledPnpm
        ? await runtimePnpmInvocation(runtime, ['run', phase.script])
        : { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `corepack pnpm run ${phase.script}`] }
      const result = await runCommand({
        id: phase.id,
        ...invocation,
        cwd: runtime,
        evidenceDir,
        identity: { ...identity, officialScript: phase.script },
      })
      phaseResults.push({ id: phase.id, exitCode: result.exitCode, runPath: result.runPath, resultPath: result.resultPath })
      if (result.exitCode !== 0) {
        await writeJson(path.join(evidenceDir, 'final-result.json'), {
          schemaVersion: 1,
          completedAtUtc: new Date().toISOString(),
          status: 'build_failed',
          failedPhase: phase.id,
          exitCode: result.exitCode,
          phases: phaseResults,
          receiptCreated: false,
          descriptorCreated: false,
        })
        return 1
      }
    }
  }

  if (!phaseResults.some(phase => phase.id === 'prepare-primary-runtime' && phase.exitCode === 0)) {
    let primaryRuntime
    if (skipPrimaryRuntimeSmoke) {
      const helperPath = path.join(evidenceDir, 'prepare-primary-runtime.mjs')
      await writeFile(helperPath, primaryRuntimePreparationSource(runtime), { flag: 'wx' })
      const helperRelative = path.relative(runtime, helperPath).replaceAll('\\', '/')
      if (/\s/.test(helperRelative)) throw new Error('primary runtime helper 的受控相对路径包含空白，拒绝传入 cmd.exe。')
      const invocation = await runtimeTsxInvocation(runtime, [helperRelative])
      primaryRuntime = await runCommand({
        id: 'prepare-primary-runtime',
        ...invocation,
        cwd: runtime,
        evidenceDir,
        identity: { ...identity, officialApi: 'scripts/primary-runtime/prepare.ts::preparePrimaryRuntime',
          smokeSkipped: 'user-request' },
      })
    } else {
      const invocation = useInstalledPnpm
        ? await runtimePnpmInvocation(runtime, ['run', 'prepare:primary-runtime', '--target', 'win-x64',
          '--output', 'apps/desktop/.desktop-build/targets/win-x64/runtime', '--cache', 'apps/desktop/.desktop-build/downloads'])
        : { command: process.env.ComSpec ?? 'cmd.exe',
          args: ['/d', '/s', '/c', 'corepack pnpm run prepare:primary-runtime -- --target win-x64 --output apps/desktop/.desktop-build/targets/win-x64/runtime --cache apps/desktop/.desktop-build/downloads'] }
      primaryRuntime = await runCommand({
        id: 'prepare-primary-runtime',
        ...invocation,
        cwd: runtime,
        evidenceDir,
        identity: { ...identity, officialScript: 'prepare:primary-runtime', target: 'win-x64' },
      })
    }
    phaseResults.push({ id: 'prepare-primary-runtime', exitCode: primaryRuntime.exitCode,
      runPath: primaryRuntime.runPath, resultPath: primaryRuntime.resultPath })
    if (primaryRuntime.exitCode !== 0) {
      await writeJson(path.join(evidenceDir, 'final-result.json'), {
        schemaVersion: 1,
        completedAtUtc: new Date().toISOString(),
        status: 'primary_runtime_failed',
        failedPhase: 'prepare-primary-runtime',
        exitCode: primaryRuntime.exitCode,
        phases: phaseResults,
        receiptCreated: false,
        descriptorCreated: false,
      })
      return 1
    }
  }

  const descriptorHelperPath = path.join(evidenceDir, 'prepare-development-project.mjs')
  await writeFile(descriptorHelperPath, descriptorPreparationSource(runtime), { flag: 'wx' })
  const descriptorHelperRelative = path.relative(runtime, descriptorHelperPath).replaceAll('\\', '/')
  if (/\s/.test(descriptorHelperRelative)) throw new Error('descriptor helper 的受控相对路径包含空白，拒绝传入 cmd.exe。')
  const descriptorInvocation = await runtimeTsxInvocation(runtime, [descriptorHelperRelative])
  const descriptorResult = await runCommand({
    id: 'descriptor',
    ...descriptorInvocation,
    cwd: runtime,
    evidenceDir,
    identity: { ...identity, officialApi: 'apps/desktop/scripts/development-project.ts::prepareDevelopmentProject' },
  })
  if (descriptorResult.exitCode !== 0) {
    activeDescriptorCreated = await assertDesktopDevelopmentProjectReady(runtime).then(() => true).catch(() => false)
    await writeJson(path.join(evidenceDir, 'final-result.json'), {
      schemaVersion: 1,
      completedAtUtc: new Date().toISOString(),
      status: 'descriptor_failed',
      exitCode: descriptorResult.exitCode,
      phases: phaseResults,
      descriptorResultPath: descriptorResult.resultPath,
      receiptCreated: false,
      descriptorCreated: activeDescriptorCreated,
    })
    return 1
  }
  const descriptorStdout = (await readFile(descriptorResult.stdoutPath, 'utf8')).trim()
  const descriptorOutputLine = descriptorStdout.split(/\r?\n/).at(-1)
  let descriptorOutput
  try { descriptorOutput = JSON.parse(descriptorOutputLine ?? '') } catch {
    throw new Error('development-project helper did not end with its JSON result line.')
  }
  if (Object.keys(descriptorOutput ?? {}).join(',') !== 'projectDir'
    || typeof descriptorOutput.projectDir !== 'string' || !path.isAbsolute(descriptorOutput.projectDir)) {
    throw new Error('development-project helper JSON result has an invalid projectDir contract.')
  }
  const descriptor = await assertDesktopDevelopmentProjectReady(runtime)
  const descriptorFromProject = path.join(descriptorOutput.projectDir, 'desktop-runtime.json')
  if (path.resolve(descriptorFromProject).toLowerCase() !== path.resolve(descriptor).toLowerCase()) {
    throw new Error('descriptor helper projectDir 与官方 validator 返回路径不一致。')
  }
  activeDescriptorCreated = true
  await assertTradeLoomDesktopAppIdentity(runtime)
  const primaryRuntimePhase = phaseResults.find(phase => phase.id === 'prepare-primary-runtime')
  if (primaryRuntimePhase?.exitCode !== 0) {
    throw new Error('official prepare:primary-runtime did not complete successfully; refusing to write a desktop receipt.')
  }
  const officialEvidencePath = path.join(evidenceDir, 'final-result.json')
  const buildEvidence = {
    builder: 'scripts/dsh/build-candidate.mjs (official upstream pnpm scripts)',
    patchesApplied: true,
    officialBuildExitCode: 0,
    primaryRuntimePreparationExitCode: primaryRuntimePhase.exitCode,
    primaryRuntimeSmoke: skipPrimaryRuntimeSmoke ? 'skipped-user-request' : 'official-smoke-completed',
    sourceCommit: lock.upstream.commit,
    patchSetSha256: patchDigest,
    ...(patchOrder === undefined ? {} : { prospectiveLockSha256: lockSha256, prospectiveOrderSha256: orderSha256 }),
    runId: reusableBuild?.runId ?? runId,
    wrapperRunId: runId,
    preflightResultPath: preflight.resultPath,
    phases: phaseResults,
    officialBuildEvidence: {
      path: officialEvidencePath,
      phaseResultSha256: await Promise.all(phaseResults.map(async phase => ({
        id: phase.id,
        sha256: await sha256File(phase.resultPath),
      }))),
    },
  }
  const receiptResult = await writeDesktopBuildReceipt({
    runtimePath: runtime,
    releaseRoot: trustedReleaseRoot,
    lock,
    buildEvidence,
    runtimeMarker: runtimeMarkerContents,
    validateOwnedRuntime,
  })
  activeReceiptCreated = true
  let receipt
  try {
    const verifier = await import('../../apps/tradeloom-launcher/desktop-receipt.mjs')
    receipt = await verifier.verifyDesktopBuildReceipt(runtime, lock, trustedReleaseRoot)
  } catch (error) {
    const { unlink } = await import('node:fs/promises')
    await unlink(receiptResult.path).catch(() => {})
    activeReceiptCreated = false
    throw error
  }
  const finalResult = {
    schemaVersion: 1,
    completedAtUtc: new Date().toISOString(),
    status: 'success',
    ...identity,
    phases: phaseResults,
    descriptorPath: descriptor,
    receiptPath: receiptResult.path,
    receiptSourceCommit: receipt.sourceCommit,
    receiptPatchSetSha256: receipt.patchSetSha256,
    compiledFiles: Object.entries(receipt.compiledFiles).map(([file, hash]) => ({ file, sha256: hash })),
    receiptCreated: true,
    descriptorCreated: true,
  }
  await writeJson(officialEvidencePath, finalResult)
  console.log(JSON.stringify({ status: 'success', evidenceDir, descriptorPath: descriptor, receiptPath: receiptResult.path }))
  return 0
}

if (import.meta.main) {
  main().then(code => { process.exitCode = code }).catch(async error => {
    const message = error instanceof Error ? error.message : String(error)
    if (activeEvidenceDir) {
      await writeJson(path.join(activeEvidenceDir, 'final-result.json'), {
        schemaVersion: 1,
        completedAtUtc: new Date().toISOString(),
        status: 'failed',
        message,
        ...(activeIdentity ?? {}),
        receiptCreated: activeReceiptCreated,
        descriptorCreated: activeDescriptorCreated,
      }).catch(() => {})
    }
    console.error(message)
    process.exitCode = 1
  })
}
