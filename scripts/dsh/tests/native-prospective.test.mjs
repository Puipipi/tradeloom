import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, lstat, readdir, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { trustedReleaseRoot } from '../../../apps/tradeloom-launcher/prepare-profile.mjs'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const workspaceRoot = path.dirname(repoRoot)
const runtime = path.join(trustedReleaseRoot, '0.2.1-rc.3-tradeloom-desktop-16')
const runtime17 = path.join(trustedReleaseRoot, '0.2.1-rc.3-tradeloom-desktop-17')
const runtime17LinkAuditPath = path.join(workspaceRoot, 'workspace/testing/clean-native-fixture-20261025/staging/evidence/workspace-link-audit.json')
const reference = path.join(workspaceRoot, 'workspace/research/references/deepseek-harness-v0.2.1-rc.3-readonly')
const patchRoot = path.join(repoRoot, 'integrations/dsh/patches')
const prospectiveRoot = path.join(workspaceRoot, 'workspace/testing/frontend-visual-fixes-20261025/batch16-native-preflight/v2-24')
const prospectiveLockPath = path.join(prospectiveRoot, 'patches.prospective.lock.json')
const patchOrderPath = path.join(prospectiveRoot, 'order.prospective.json')
const prospective25Root = path.join(workspaceRoot, 'workspace/testing/frontend-visual-fixes-20261025/batch16-native-preflight/v3-25')
const prospective25LockPath = path.join(prospective25Root, 'patches.prospective.lock.json')
const patchOrder25Path = path.join(prospective25Root, 'order.prospective.json')
const receiptPath = path.join(runtime, '.tradeloom-desktop-build-receipt.json')

async function runtimeAvailable(t) {
  try { await lstat(receiptPath); return true } catch (error) {
    if (error.code === 'ENOENT') { t.skip('desktop-16 receipt fixture is not present on this host'); return false }
    throw error
  }
}

function runPwsh(script, args) {
  return spawnSync('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(repoRoot, 'scripts/dsh', script), ...args,
  ], { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
}

function resultJson(result) {
  assert.equal(result.error, undefined, result.error?.message)
  const lines = result.stdout.trim().split(/\r?\n/)
  return JSON.parse(lines.at(-1))
}

function patchSetDigest(patches) {
  const entries = Object.entries(patches).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

test('v3-25 preserves the reviewed 24-patch set and adds only the diagnostics tsconfig include', async () => {
  const [v2Lock, v2Order, v3Lock, v3Order] = await Promise.all([
    readFile(path.join(prospectiveRoot, 'patches.prospective.lock.json'), 'utf8').then(JSON.parse),
    readFile(patchOrderPath, 'utf8').then(JSON.parse),
    readFile(prospective25LockPath, 'utf8').then(JSON.parse),
    readFile(patchOrder25Path, 'utf8').then(JSON.parse),
  ])
  const patchName = 'desktop-ai-web-diagnostics-tsconfig.patch'
  assert.equal(createHash('sha256').update(await readFile(path.join(prospective25Root, 'patches.prospective.lock.json'))).digest('hex'),
    '31c63c81bd4bf3adae868e0d6e173bf36b5c4c54e288f424c3dfd693bfab65bf')
  assert.equal(createHash('sha256').update(await readFile(patchOrder25Path)).digest('hex'),
    '4555a7185ef1b08b7584974c1e27879df5ec0db2789848ba9e017aa58933cadd')
  assert.deepEqual(v3Order.order.slice(0, 24), v2Order.order)
  assert.equal(v3Order.count, 25)
  assert.equal(v3Order.order.at(-1), patchName)
  for (const [name, digest] of Object.entries(v2Lock.patches)) assert.equal(v3Lock.patches[name], digest)
  for (const [relative, target] of Object.entries(v2Lock.targetFiles)) assert.deepEqual(v3Lock.targetFiles[relative], target)
  assert.deepEqual(v3Lock.targetFiles['apps/desktop/tsconfig.client.json'], {
    baseSha256: '938484f3adbd521089b1cf3a95a5d605b9fb16a2417f48dd1bea0d87341ac36a',
    newSha256: 'c4da16cc32d74e8d2ace1d9ac321602c97b306b0d9bd2608c3cf9ed3e2ef98b6',
  })
  assert.equal(v3Lock.upstream.commit, v2Lock.upstream.commit)
  assert.equal(v3Lock.upstream.licenseSha256, v2Lock.upstream.licenseSha256)
  assert.equal(patchSetDigest(v3Lock.patches), '6b9288b465d073ca5da4a049f1ad5f5c81fb7e57017d8ec4f8b012e6c54e5047')
  assert.equal(createHash('sha256').update(await readFile(path.join(patchRoot, patchName))).digest('hex'), v3Lock.patches[patchName].toLowerCase())

  const sourcePath = path.join(workspaceRoot, 'workspace/research/references/deepseek-harness-v0.2.1-rc.3-readonly/apps/desktop/tsconfig.client.json')
  const source = await readFile(sourcePath, 'utf8')
  const updated = source.replace('    "src/locale.ts"', '    "src/ai-web-diagnostics.ts",\n    "src/locale.ts"')
  assert.notEqual(updated, source)
  assert.equal(createHash('sha256').update(source).digest('hex'), v3Lock.targetFiles['apps/desktop/tsconfig.client.json'].baseSha256)
  assert.equal(createHash('sha256').update(updated).digest('hex'), v3Lock.targetFiles['apps/desktop/tsconfig.client.json'].newSha256)

  const tampered = structuredClone(v3Lock.patches)
  tampered[patchName] = '0'.repeat(64)
  assert.notEqual(patchSetDigest(tampered), patchSetDigest(v3Lock.patches), 'a changed patch hash must change the locked set digest')
  const tamperedLockBytes = Buffer.from(JSON.stringify({ ...v3Lock, patches: tampered }))
  assert.notEqual(createHash('sha256').update(tamperedLockBytes).digest('hex'),
    '31c63c81bd4bf3adae868e0d6e173bf36b5c4c54e288f424c3dfd693bfab65bf',
    'a tampered lock must not retain the reviewed lock digest')
})

async function receiptBytes() {
  return readFile(receiptPath)
}

function statIdentity(info) {
  return {
    dev: info.dev.toString(), ino: info.ino.toString(), mode: info.mode,
    birthtimeMs: info.birthtimeMs, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
  }
}

async function dependencyClosureSnapshot() {
  // The reviewed audit supplies the closure path set; recheck links without traversing package payloads.
  const audit = JSON.parse(await readFile(runtime17LinkAuditPath, 'utf8'))
  const links = []
  for (const entry of audit.links) {
    const info = await lstat(entry.path)
    assert.equal(info.isSymbolicLink(), true, `audited dependency link changed kind: ${entry.path}`)
    const target = await realpath(entry.path)
    const relative = path.relative(runtime17, target)
    links.push({
      path: entry.path,
      rawTarget: await readlink(entry.path),
      realpath: target,
      insideWorkspace: relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)),
    })
  }
  const linkTableSha256 = createHash('sha256').update(JSON.stringify(links)).digest('hex')
  assert.equal(linkTableSha256, audit.totals.linkTableSha256, 'runtime-17 dependency link closure differs from the reviewed audit')
  const inputPaths = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'node_modules/.modules.yaml']
  const inputs = {}
  for (const relative of inputPaths) {
    const bytes = await readFile(path.join(runtime17, relative))
    inputs[relative] = createHash('sha256').update(bytes).digest('hex')
  }
  return { reviewedLinkCount: audit.links.length, linkTableSha256, inputs }
}

async function runtime17Snapshot() {
  let rootInfo
  try { rootInfo = await lstat(runtime17) } catch (error) {
    if (error.code === 'ENOENT') return { exists: false }
    throw error
  }
  assert.equal(rootInfo.isDirectory(), true, 'runtime-17 root must remain an ordinary directory')
  const entries = []
  const visit = async (absolute, relative) => {
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) {
      entries.push({ path: relative, kind: 'symlink', identity: statIdentity(info), target: await readlink(absolute) })
      return
    }
    if (info.isDirectory()) {
      entries.push({ path: relative, kind: 'directory', identity: statIdentity(info) })
      // Prune every node_modules directory wherever it appears (apps, packages, vendor, etc.).
      if (path.basename(absolute).toLowerCase() === 'node_modules') return
      const children = (await readdir(absolute)).sort()
      for (const child of children) await visit(path.join(absolute, child), path.join(relative, child))
      return
    }
    if (info.isFile()) {
      const bytes = await readFile(absolute)
      entries.push({ path: relative, kind: 'file', identity: statIdentity(info), size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') })
      return
    }
    entries.push({ path: relative, kind: 'other', identity: statIdentity(info) })
  }
  await visit(runtime17, '.')
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { exists: true, entries, dependencyClosure: await dependencyClosureSnapshot() }
}

const oldExitHash = 'D42CE2946B13EA469A0C7EEFCEF2FC37BD9C52F7CC0A6570BCF9129007190ADA'
const currentExitHash = '5D425663FB854D1E9C137B112C8F3DEAD90F43B4ADC359F4C538DD89861D41D9'
async function assertExitDrift(lockPath) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  assert.equal(lock.patches['desktop-pane-popout.patch'], oldExitHash)
  assert.equal(createHash('sha256').update(await readFile(path.join(patchRoot, 'desktop-pane-popout.patch'))).digest('hex').toUpperCase(), currentExitHash)
}
for (const [name, args, lock] of [
  ['default', [], path.join(patchRoot, 'patches.lock.json')],
  ['v2-24', ['-ProspectiveLockPath', prospectiveLockPath, '-PatchRoot', patchRoot, '-PatchOrder', patchOrderPath], prospectiveLockPath],
  ['v3-25', ['-ProspectiveLockPath', prospective25LockPath, '-PatchRoot', patchRoot, '-PatchOrder', patchOrder25Path], prospective25LockPath],
]) {
  test(`${name} checker rejects exact exit patch drift without changing desktop16 receipt`, async t => {
    if (!(await runtimeAvailable(t))) return
    const before = await receiptBytes(); await assertExitDrift(lock)
    const result = runPwsh('check-upstream.ps1', ['-RuntimePath', runtime, ...args]); const body = resultJson(result)
    assert.equal(result.status, 24); assert.equal(body.status, 'patch_hash_mismatch')
    assert.equal(body.patch, 'desktop-pane-popout.patch'); assert.equal(body.expected, oldExitHash); assert.equal(body.actual, currentExitHash)
    assert.deepEqual(await receiptBytes(), before)
  })
}

test('prepare keeps default selection, rejects partial selection, and never overwrites desktop-16', async t => {
  if (!(await runtimeAvailable(t))) return
  const before = await receiptBytes()
  const partial = runPwsh('prepare-runtime.ps1', [
    '-ReferencePath', reference,
    '-RuntimePath', runtime,
    '-ProspectiveLockPath', prospectiveLockPath,
  ])
  assert.equal(resultJson(partial).status, 'parameter_set_rejected')
  assert.equal(partial.status, 21)

  const defaults = runPwsh('prepare-runtime.ps1', ['-ReferencePath', reference, '-RuntimePath', runtime])
  assert.equal(resultJson(defaults).status, 'target_exists')
  assert.equal(defaults.status, 20)

  const prospective = runPwsh('prepare-runtime.ps1', [
    '-ReferencePath', reference,
    '-RuntimePath', runtime,
    '-ProspectiveLockPath', prospectiveLockPath,
    '-PatchRoot', patchRoot,
    '-PatchOrder', patchOrderPath,
  ])
  assert.equal(resultJson(prospective).status, 'target_exists')
  assert.equal(prospective.status, 20)

  const prospective25 = runPwsh('prepare-runtime.ps1', [
    '-ReferencePath', reference,
    '-RuntimePath', runtime,
    '-ProspectiveLockPath', prospective25LockPath,
    '-PatchRoot', patchRoot,
    '-PatchOrder', patchOrder25Path,
  ])
  assert.equal(resultJson(prospective25).status, 'target_exists')
  assert.equal(prospective25.status, 20)
  assert.deepEqual(await receiptBytes(), before)
})

test('PowerShell selectors reject explicitly bound empty and whitespace override values', async t => {
  if (!(await runtimeAvailable(t))) return
  const before = await receiptBytes()
  const invalidGroups = [
    ['-ProspectiveLockPath', ''],
    ['-ProspectiveLockPath', '', '-PatchRoot', '', '-PatchOrder', ''],
    ['-ProspectiveLockPath', ' ', '-PatchRoot', patchRoot, '-PatchOrder', patchOrderPath],
    ['-ProspectiveLockPath', prospectiveLockPath, '-PatchRoot', '  ', '-PatchOrder', patchOrderPath],
    ['-ProspectiveLockPath', prospectiveLockPath, '-PatchRoot', patchRoot, '-PatchOrder', '\t'],
  ]

  for (const overrideArgs of invalidGroups) {
    const prepare = runPwsh('prepare-runtime.ps1', [
      '-ReferencePath', reference, '-RuntimePath', runtime, ...overrideArgs,
    ])
    assert.equal(resultJson(prepare).status, 'parameter_set_rejected')
    assert.equal(prepare.status, 21)

    const check = runPwsh('check-upstream.ps1', ['-RuntimePath', runtime, ...overrideArgs])
    assert.equal(resultJson(check).status, 'parameter_set_rejected')
    assert.equal(check.status, 21)
  }

  const aliasBlank = ['-ProspectiveLockPath', prospectiveLockPath, '-PatchRoot', ' ', '-PatchOrder', patchOrderPath]
  const aliasPrepare = runPwsh('prepare-runtime.ps1', [
    '-ReferencePath', reference, '-RuntimePath', runtime, ...aliasBlank,
  ])
  assert.equal(resultJson(aliasPrepare).status, 'parameter_set_rejected')
  const aliasCheck = runPwsh('check-upstream.ps1', ['-RuntimePath', runtime, ...aliasBlank])
  assert.equal(resultJson(aliasCheck).status, 'parameter_set_rejected')
  assert.deepEqual(await receiptBytes(), before)
})

test('build selector rejects foreign paths and exact old exit patch drift before build', async t => {
  if (!(await runtimeAvailable(t))) return
  const before = await receiptBytes()
  const runtime17Before = await runtime17Snapshot()
  const script = path.join(repoRoot, 'scripts/dsh/build-candidate.mjs')
  const partial = spawnSync(process.execPath, [script, '--runtime', runtime, '--prospective-lock-path', prospectiveLockPath], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(partial.status, 1)
  assert.match(partial.stderr, /must be supplied together/)

  const foreign = spawnSync(process.execPath, [script, '--runtime', runtime,
    '--prospective-lock-path', prospectiveLockPath, '--patch-root', path.dirname(patchRoot), '--patch-order', patchOrderPath], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(foreign.status, 1)
  assert.match(foreign.stderr, /approved v2-24, v3-25, v4-26, patch-set-27, patch-set-28, patch-set-29, patch-set-32 or patch-set-33 lock\/order and repository patch root/)

  const foreign25 = spawnSync(process.execPath, [script, '--runtime', runtime,
    '--prospective-lock-path', prospective25LockPath, '--patch-root', path.dirname(patchRoot), '--patch-order', patchOrder25Path], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(foreign25.status, 1)
  assert.match(foreign25.stderr, /approved v2-24, v3-25, v4-26, patch-set-27, patch-set-28, patch-set-29, patch-set-32 or patch-set-33 lock\/order and repository patch root/)

  const defaults = spawnSync(process.execPath, [script, '--runtime', runtime], { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
  assert.equal(defaults.status, 1)
  assert.match(defaults.stderr, /candidate runtime 已有构建 receipt/)

  const prospective = spawnSync(process.execPath, [script, '--runtime', runtime,
    '--prospective-lock-path', prospectiveLockPath, '--patch-root', patchRoot, '--patch-order', patchOrderPath], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(prospective.status, 1)
  await assertExitDrift(prospectiveLockPath)
  assert.match(prospective.stderr, /Prospective patch hash mismatch: desktop-pane-popout\.patch/)
  assert.deepEqual(await receiptBytes(), before)

  const prospective25 = spawnSync(process.execPath, [script, '--runtime', runtime,
    '--prospective-lock-path', prospective25LockPath, '--patch-root', patchRoot, '--patch-order', patchOrder25Path], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(prospective25.status, 1)
  await assertExitDrift(prospective25LockPath)
  assert.match(prospective25.stderr, /Prospective patch hash mismatch: desktop-pane-popout\.patch/)
  assert.deepEqual(await receiptBytes(), before)
  assert.deepEqual(await runtime17Snapshot(), runtime17Before)
})

test('Node build selector rejects empty, whitespace, and mixed-blank prospective groups before build', async () => {
  const script = path.join(repoRoot, 'scripts/dsh/build-candidate.mjs')
  const invalidGroups = [
    ['--prospective-lock-path', ''],
    ['--prospective-lock-path', ' ', '--patch-root', '\t', '--patch-order', '  '],
    ['--prospective-lock-path', prospectiveLockPath, '--patch-root', '', '--patch-order', patchOrderPath],
  ]
  for (const group of invalidGroups) {
    const result = spawnSync(process.execPath, [script, '--runtime', runtime, ...group], {
      cwd: repoRoot, encoding: 'utf8', windowsHide: true,
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /must be supplied together with non-blank values/)
    assert.doesNotMatch(result.stderr, /candidate runtime 已有构建 receipt/)
  }
})

test('v4-26 preserves all 25 reviewed patches and adds only startup observation targets', async () => {
  const root = path.join(workspaceRoot, 'workspace/testing/frontend-visual-fixes-20261025/batch16-native-preflight/v4-26')
  const parent = JSON.parse(await readFile(prospective25LockPath, 'utf8'))
  const lock = JSON.parse(await readFile(path.join(root, 'patches.prospective.lock.json'), 'utf8'))
  const order = JSON.parse(await readFile(path.join(root, 'order.prospective.json'), 'utf8'))
  const parentOrder = JSON.parse(await readFile(patchOrder25Path, 'utf8'))
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))
  assert.deepEqual(order.order.slice(0,25), parentOrder.order)
  assert.equal(order.count,26)
  assert.equal(order.order.at(-1),'native-startup-observation.patch')
  for(const [name,digest] of Object.entries(parent.patches)) assert.equal(lock.patches[name],digest)
  const changed = ['apps/desktop/src/main.ts','apps/desktop/src/host-process.ts','apps/desktop/src/backend-controller.ts','apps/desktop/src/welcome-window.ts']
  for(const [file,target] of Object.entries(parent.targetFiles)) if(!changed.includes(file)) assert.deepEqual(lock.targetFiles[file],target)
  assert.deepEqual(lock.upstream,parent.upstream)
  assert.equal(manifest.generatedTargetCount,10)
  assert.equal(patchSetDigest(lock.patches),manifest.patchSetSha256)
  assert.equal(createHash('sha256').update(await readFile(path.join(root,'patches.prospective.lock.json'))).digest('hex'),manifest.lockSha256)
  assert.equal(createHash('sha256').update(await readFile(path.join(root,'order.prospective.json'))).digest('hex'),manifest.orderSha256)
  assert.equal(createHash('sha256').update(await readFile(path.join(patchRoot,'native-startup-observation.patch'))).digest('hex'),'3e09981c79c82d4a67630aaf715e75c866769ef71ca2004ddfafa0b0c4176ef9')
  const { usesInstalledPnpm } = await import('../build-candidate.mjs')
  assert.equal(usesInstalledPnpm('v4-26'),true)
})

test('v4-26 rejects exact exit patch drift and preserves known16 receipt', async t => {
  if (!(await runtimeAvailable(t))) return
  const before=await receiptBytes()
  const root=path.join(workspaceRoot,'workspace/testing/frontend-visual-fixes-20261025/batch16-native-preflight/v4-26')
  const lock=path.join(root,'patches.prospective.lock.json'), order=path.join(root,'order.prospective.json')
  const prepare=runPwsh('prepare-runtime.ps1',['-ReferencePath',reference,'-RuntimePath',runtime,'-ProspectiveLockPath',lock,'-PatchRoot',patchRoot,'-PatchOrder',order])
  assert.equal(resultJson(prepare).status,'target_exists'); assert.equal(prepare.status,20)
  const build=spawnSync(process.execPath,[path.join(repoRoot,'scripts/dsh/build-candidate.mjs'),'--runtime',runtime,'--prospective-lock-path',lock,'--patch-root',patchRoot,'--patch-order',order],{cwd:repoRoot,encoding:'utf8',windowsHide:true})
  assert.equal(build.status,1); await assertExitDrift(lock); assert.match(build.stderr,/Prospective patch hash mismatch: desktop-pane-popout\.patch/)
  assert.deepEqual(await receiptBytes(),before)
})

test('exit candidate selector reaches receipt guard and rejects wrong root', async t => {
  if (!(await runtimeAvailable(t))) return
  const before = await receiptBytes()
  const root = path.join(workspaceRoot, 'workspace/testing/desktop24-exit-fix-build-20261027/patch-set-33-exit')
  const lock = path.join(root, 'patches.prospective.lock.json'), order = path.join(root, 'order.prospective.json')
  const script = path.join(repoRoot, 'scripts/dsh/build-candidate.mjs')
  const run = args => spawnSync(process.execPath, [script, '--runtime', runtime, ...args], { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
  const accepted = run(['--prospective-lock-path', lock, '--patch-root', patchRoot, '--patch-order', order])
  assert.equal(accepted.status, 1); assert.match(accepted.stderr, /candidate runtime 已有构建 receipt/)
  const wrongRoot = run(['--prospective-lock-path', lock, '--patch-root', path.dirname(patchRoot), '--patch-order', order])
  assert.equal(wrongRoot.status, 1); assert.match(wrongRoot.stderr, /repository patch root/)
  const partial = run(['--prospective-lock-path', lock]); assert.equal(partial.status, 1); assert.match(partial.stderr, /must be supplied together/)
  assert.deepEqual(await receiptBytes(), before)
})

test('repository desktop24 selector reaches receipt guard and rejects mismatched or tampered inputs', async t => {
  if (!(await runtimeAvailable(t))) return
  const before = await receiptBytes()
  const root = path.join(repoRoot, 'integrations/dsh/prospective/desktop24-exit')
  const lock = path.join(root, 'patches.prospective.lock.json'), order = path.join(root, 'order.prospective.json'), patches = path.join(root, 'patches')
  const script = path.join(repoRoot, 'scripts/dsh/build-candidate.mjs')
  const run = args => spawnSync(process.execPath, [script, '--runtime', runtime, ...args], { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
  const accepted = run(['--prospective-lock-path', lock, '--patch-root', patches, '--patch-order', order])
  assert.equal(accepted.status, 1); assert.match(accepted.stderr, /candidate runtime 已有构建 receipt/)
  const wrong = run(['--prospective-lock-path', lock, '--patch-root', patchRoot, '--patch-order', order])
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /repository patch root/)
  const temp = await import('node:os').then(os => os.tmpdir()); const fs = await import('node:fs/promises')
  const dir = await fs.mkdtemp(path.join(temp, 'desktop24-lock-test-'))
  try { const tampered = path.join(dir, 'patches.prospective.lock.json'); await fs.writeFile(tampered, (await fs.readFile(lock, 'utf8')) + ' ')
    const result = run(['--prospective-lock-path', tampered, '--patch-root', patches, '--patch-order', order]); assert.equal(result.status, 1); assert.match(result.stderr, /repository patch root/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
  assert.deepEqual(await receiptBytes(), before)
})
