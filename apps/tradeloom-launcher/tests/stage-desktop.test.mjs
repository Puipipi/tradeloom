import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { stageDesktop } from '../stage-desktop.mjs'
import { runtimeMarkerContents, runtimeMarkerName, trustedReleaseRoot } from '../prepare-profile.mjs'
import { BOOTSTRAP_MARKER, BOOTSTRAP_MARKER_CONTENT, MANIFEST_NAME } from '../bootstrap-core.mjs'
import { validateManifest } from '../bootstrap-core.mjs'

const hostAddress = '192.168.8.20'
const interfaces = () => ({ ethernet: [{ family: 'IPv4', address: hostAddress, internal: false }] })

test('stage generator requires an owned pinned runtime and emits only explicit launcher/resources files', async t => {
  const local = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-stage-local-'))
  const runtimeName = `stage-fixture-${randomUUID()}`
  const runtime = path.join(trustedReleaseRoot, runtimeName)
  const product = path.join(local, 'TradeLoom')
  const stage = path.join(product, 'staging', 'desktop')
  t.after(async () => { await rm(local, { recursive: true, force: true }); await rm(runtime, { recursive: true, force: true }) })
  await mkdir(path.join(runtime, 'apps/desktop/lib'), { recursive: true })
  const compiledMain = 'controlled fixture main\n'
  await writeFile(path.join(runtime, 'apps/desktop/lib/main.js'), compiledMain)
  await mkdir(path.join(runtime, 'apps/desktop-host/lib'), { recursive: true })
  await mkdir(path.join(runtime, 'apps/desktop/lib'), { recursive: true })
  await writeFile(path.join(runtime, 'apps/desktop-host/lib/index.js'), 'fixture host build\n')
  await writeFile(path.join(runtime, runtimeMarkerName), runtimeMarkerContents)
  const lock = JSON.parse(await readFile(new URL('../../../integrations/dsh/patches/patches.lock.json', import.meta.url), 'utf8'))
  const { writeDesktopBuildReceipt, patchSetDigest } = await import('../receipt-writer.mjs')
  const { validateOwnedRuntime } = await import('../prepare-profile.mjs')
  await writeDesktopBuildReceipt({ runtimePath: runtime, releaseRoot: trustedReleaseRoot, lock, runtimeMarker: runtimeMarkerContents,
    validateOwnedRuntime, buildEvidence: { patchesApplied: true, officialBuildExitCode: 0, sourceCommit: lock.upstream.commit,
      patchSetSha256: patchSetDigest(lock.patches), builder: 'isolated-stage-fixture' } })
  const python = path.join(product, 'python-env/Scripts/python.exe')
  const manage = path.join(product, 'backend/manage.py')
  await mkdir(path.dirname(python), { recursive: true })
  await mkdir(path.dirname(manage), { recursive: true })
  await writeFile(python, 'fixture only')
  await writeFile(manage, '# fixture only')

  const result = await stageDesktop({ env: { LOCALAPPDATA: local }, runtimePath: runtime, pythonPath: python,
    managePath: manage, hostAddress, networkInterfaces: interfaces })
  assert.equal(result.stagePath, stage)
  assert.equal(result.manifest.appMainSha256, createHash('sha256').update(compiledMain).digest('hex'))
  assert.equal(await readFile(path.join(stage, 'resources/tradeloom', BOOTSTRAP_MARKER), 'utf8'), BOOTSTRAP_MARKER_CONTENT)
  const stagedManifest = JSON.parse(await readFile(path.join(stage, 'resources/tradeloom', MANIFEST_NAME), 'utf8'))
  assert.equal(stagedManifest.hostAddress, hostAddress)
  const deployment = validateManifest(stagedManifest, product, path.join(product, 'workspace'))
  assert.equal(deployment.runtime, path.join(product, 'runtime/releases', runtimeName))
  assert.equal(path.relative(product, deployment.runtime).startsWith('..'), false)
  assert.equal(result.resourcesPath, path.join(stage, 'resources'))
  assert.equal(path.basename(path.join(result.resourcesPath, 'tradeloom')), 'tradeloom')
  for (const name of ['bootstrap-entry.mjs', 'installed-bootstrap.mjs', 'bootstrap-core.mjs', 'receipt-writer.mjs', 'core.mjs', 'prepare-profile.mjs', 'desktop-receipt.mjs']) {
    assert.equal((await readFile(path.join(stage, 'launcher', name), 'utf8')).length > 0, true)
  }
  await assert.rejects(stageDesktop({ env: { LOCALAPPDATA: local }, runtimePath: path.join(local, 'foreign'),
    pythonPath: python, managePath: manage, hostAddress, networkInterfaces: interfaces }), /固定 TradeLoom releases 根下/)
})

test('stage generator rejects missing deployment inputs before creating stage', async t => {
  const local = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-stage-reject-'))
  const stage = path.join(local, 'TradeLoom/staging/desktop')
  t.after(() => rm(local, { recursive: true, force: true }))
  await assert.rejects(stageDesktop({ env: { LOCALAPPDATA: local }, hostAddress: '8.8.8.8' }), /部署资料不完整/)
  assert.equal(await import('node:fs/promises').then(fs => fs.stat(stage).then(() => true, () => false)), false)
})


test('packaged stage copies verified business, Python dependency, and PostgreSQL resources', async t => {
  const local = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-package-stage-'))
  const runtimeName = 'package-stage-fixture-' + randomUUID()
  const runtime = path.join(trustedReleaseRoot, runtimeName)
  const stage = path.join(local, 'stage-output')
  const payloadRoot = path.join(local, 'payloads')
  const b2 = path.join(payloadRoot, 'b2')
  const pg = path.join(payloadRoot, 'pg17')
  const evidence = path.join(payloadRoot, 'evidence')
  t.after(async () => { await rm(local, { recursive: true, force: true }); await rm(runtime, { recursive: true, force: true }) })
  await mkdir(path.join(runtime, 'apps/desktop/lib'), { recursive: true })
  const compiledMain = 'packaged fixture main\n'
  await writeFile(path.join(runtime, 'apps/desktop/lib/main.js'), compiledMain)
  await mkdir(path.join(runtime, 'apps/desktop-host/lib'), { recursive: true })
  await writeFile(path.join(runtime, 'apps/desktop-host/lib/index.js'), 'fixture host build\n')
  await writeFile(path.join(runtime, runtimeMarkerName), runtimeMarkerContents)
  const lock = JSON.parse(await readFile(new URL('../../../integrations/dsh/patches/patches.lock.json', import.meta.url), 'utf8'))
  const { writeDesktopBuildReceipt, patchSetDigest } = await import('../receipt-writer.mjs')
  const { validateOwnedRuntime } = await import('../prepare-profile.mjs')
  await writeDesktopBuildReceipt({ runtimePath: runtime, releaseRoot: trustedReleaseRoot, lock, runtimeMarker: runtimeMarkerContents,
    validateOwnedRuntime, buildEvidence: { patchesApplied: true, officialBuildExitCode: 0, sourceCommit: lock.upstream.commit,
      patchSetSha256: patchSetDigest(lock.patches), builder: 'isolated-package-stage-fixture' } })

  await mkdir(path.join(b2, 'python-packages', 'django'), { recursive: true })
  await writeFile(path.join(b2, 'python-packages', 'django', '__init__.py'), 'fixture django\n')
  await mkdir(path.join(b2, 'python-packages', '__pycache__'), { recursive: true })
  await writeFile(path.join(b2, 'python-packages', '__pycache__', 'ignored.pyc'), 'cache')
  const dependencyFiles = [
    { path: 'django/__init__.py', sha256: createHash('sha256').update('fixture django\n').digest('hex'), bytes: Buffer.byteLength('fixture django\n') },
    { path: '__pycache__/ignored.pyc', sha256: createHash('sha256').update('cache').digest('hex'), bytes: 5 },
  ]
  await mkdir(evidence, { recursive: true })
  const dependencyManifestPath = path.join(b2, 'backend-runtime-manifest.json')
  const dependencyFilesManifestPath = path.join(evidence, 'python-files.json')
  const sourceRequirements = await readFile(new URL('../../../requirements-workbench.txt', import.meta.url))
  const sourceRequirementsSha256 = createHash('sha256').update(sourceRequirements).digest('hex')
  await writeFile(dependencyManifestPath, JSON.stringify({ schemaVersion: 1, runtime: { platform: 'win32', arch: 'x64', pythonVersion: '3.12.14' }, backendDependencies: { sitePackagesRelativePath: 'python-packages', sourceRequirementsSha256, distributions: [{ name: 'Django', version: '5.2.18' }], licenseFiles: [] } }))
  await writeFile(dependencyFilesManifestPath, JSON.stringify(dependencyFiles))

  await mkdir(path.join(pg, 'pgsql', 'bin'), { recursive: true })
  await writeFile(path.join(pg, 'pgsql', 'bin', 'postgres.exe'), 'postgres fixture')
  const pgBytes = Buffer.from('postgres fixture')
  const pgManifestPath = path.join(pg, 'postgres-runtime-manifest.json')
  const pgFilesManifestPath = path.join(evidence, 'postgres-files.json')
  const pgBinarySha = createHash('sha256').update(pgBytes).digest('hex')
  const pgLicense = Buffer.from('fixture license')
  const pgLicenseSha = createHash('sha256').update(pgLicense).digest('hex')
  const pgFiles = [
    { path: 'pgsql/bin/postgres.exe', bytes: pgBytes.length, sha256: pgBinarySha },
    { path: 'pgsql/server_license.txt', bytes: pgLicense.length, sha256: pgLicenseSha },
  ]
  const pgTreeSha = createHash('sha256').update(pgFiles.map(item => item.path + '\0' + item.sha256 + '\n').sort().join('')).digest('hex')
  await writeFile(pgManifestPath, JSON.stringify({ schemaVersion: 1, product: 'PostgreSQL', version: '17.11', platform: 'win32', arch: 'x64', payload: { rootRelativePath: 'pgsql', treeSha256: pgTreeSha, licenseFiles: ['pgsql/server_license.txt'] }, entrypoints: [{ path: 'pgsql/bin/postgres.exe', sha256: pgBinarySha }] }))
  await writeFile(path.join(pg, 'pgsql', 'server_license.txt'), 'fixture license')
  await writeFile(pgFilesManifestPath, JSON.stringify(pgFiles))

  const result = await stageDesktop({ mode: 'packaged', runtimePath: runtime, stagePath: stage,
    pythonPayloadRoot: b2, pythonManifestPath: dependencyManifestPath, pythonFilesManifestPath: dependencyFilesManifestPath,
    postgresPayloadRoot: pg, postgresManifestPath: pgManifestPath, postgresFilesManifestPath: pgFilesManifestPath })
  const packaged = path.join(stage, 'resources', 'tradeloom')
  assert.equal(await readFile(path.join(packaged, 'backend', 'manage.py'), 'utf8').then(() => true, () => false), true)
  assert.equal(await readFile(path.join(packaged, 'python-packages', 'django', '__init__.py'), 'utf8'), 'fixture django\n')
  assert.equal(await readFile(path.join(packaged, 'postgresql', 'pgsql', 'bin', 'postgres.exe'), 'utf8'), 'postgres fixture')
  assert.equal(await readFile(path.join(packaged, 'postgresql', 'pgsql', 'server_license.txt'), 'utf8'), 'fixture license')
  assert.equal(await import('node:fs/promises').then(fs => fs.stat(path.join(packaged, 'python-packages', '__pycache__')).then(() => true, () => false)), false)
  assert.equal(result.manifest.deploymentMode, 'packaged')
  assert.equal(result.manifest.resources.pythonDependencies.version, '3.12.14')
  assert.equal(result.manifest.resources.postgresql.version, '17.11')
  assert.equal(result.manifest.resources.businessShell.root, 'resources/tradeloom/business-shell')
  assert.equal(result.manifest.runtime.python, 'resources/runtime/primary-runtime/dependencies/python/python.exe')
  assert.equal(await readFile(path.join(packaged, 'business-shell', 'package.json'), 'utf8').then(value => JSON.parse(value).name), '@tradeloom/dsh-business-shell')
  const stagedShellManifest = JSON.parse(await readFile(path.join(packaged, 'business-shell', 'package.json'), 'utf8'))
  assert.ok(stagedShellManifest.files.includes('client.scenes.js'))
  assert.ok(stagedShellManifest.files.includes('scenes.json'))
  assert.equal(await readFile(path.join(packaged, 'business-shell', 'client.scenes.js'), 'utf8'),
    await readFile(new URL('../../../packages/tradeloom-shell/client.scenes.js', import.meta.url), 'utf8'))
  assert.deepEqual(JSON.parse(await readFile(path.join(packaged, 'business-shell', 'scenes.json'), 'utf8')),
    JSON.parse(await readFile(new URL('../../../packages/tradeloom-shell/scenes.json', import.meta.url), 'utf8')))
  assert.equal(await readFile(path.join(packaged, 'business-shell', 'assets/tradeloom-mark.svg'), 'utf8'),
    await readFile(new URL('../../../packages/tradeloom-shell/assets/tradeloom-mark.svg', import.meta.url), 'utf8'))
  assert.equal(result.manifest.resources.business.files.some(item => item.path === '.env'), false)
  assert.equal(result.manifest.resources.business.files.some(item => item.path.includes('/tests/')), false)
  assert.equal(JSON.stringify(result.manifest).includes(local), false)
  assert.equal(JSON.stringify(result.manifest).includes(path.resolve(process.cwd())), false)
  assert.equal(JSON.stringify(result.manifest).includes(payloadRoot), false)
  await writeFile(path.join(b2, 'python-packages', 'unlisted.py'), 'not in frozen inventory')
  await assert.rejects(stageDesktop({ mode: 'packaged', runtimePath: runtime, stagePath: path.join(local, 'tampered-stage'),
    pythonPayloadRoot: b2, pythonManifestPath: dependencyManifestPath, pythonFilesManifestPath: dependencyFilesManifestPath,
    postgresPayloadRoot: pg, postgresManifestPath: pgManifestPath, postgresFilesManifestPath: pgFilesManifestPath }), /实际文件树与冻结清单不一致/)
})
