import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { assertNoReparseAncestors, bundleDestinationIsCurrent, runtimeMarkerContents, runtimeMarkerName, sameDirectoryIdentity, trustedReleaseRoot, validateOwnedRuntime } from '../prepare-profile.mjs'
import { desktopReceiptFiles, desktopReceiptName, expectedPatchSetDigest, verifyDesktopBuildReceipt } from '../desktop-receipt.mjs'
import { patchSetDigest, writeDesktopBuildReceipt } from '../receipt-writer.mjs'

const lock = { upstream: { commit: '1f81c047fc48fa190a683e469daa699857e9afe8' }, patches: { 'one.patch': 'a'.repeat(64) } }
const sha = value => createHash('sha256').update(value).digest('hex')
const workspaceRoot = process.env.TRADELOOM_TEST_WORKSPACE_ROOT
  ? path.resolve(process.env.TRADELOOM_TEST_WORKSPACE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../workspace')

test('8.3-style release-root alias is accepted only when directory identity is proven', async () => {
  const alias = 'C:\\TRADEL~1\\RELEASES'
  const trusted = 'C:\\TradeLoom Runtime\\releases'
  const statFor = identities => async target => ({
    isDirectory: () => true,
    dev: identities[target][0],
    ino: identities[target][1],
  })
  assert.equal(await sameDirectoryIdentity(alias, trusted, statFor({
    [alias]: [4n, 91n], [trusted]: [4n, 91n],
  })), true)
  assert.equal(await sameDirectoryIdentity(alias, trusted, statFor({
    [alias]: [4n, 91n], [trusted]: [4n, 92n],
  })), false)
  assert.equal(await sameDirectoryIdentity(alias, trusted, statFor({
    [alias]: [0n, 0n], [trusted]: [0n, 0n],
  })), false)
})

test('validateOwnedRuntime accepts a real 8.3 alias for the runtime leaf', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-runtime-short-alias-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const releases = path.join(temp, 'releases')
  const releaseName = '0.2.1-rc.3-tradeloom-desktop-fixture-release'
  const runtime = path.join(releases, releaseName)
  await mkdir(runtime, { recursive: true })
  await writeFile(path.join(runtime, runtimeMarkerName), runtimeMarkerContents)

  const shortPath = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `for %I in ("${runtime}") do @echo %~sI`], {
    encoding: 'utf8', windowsHide: true,
  }).trim()
  if (!shortPath || path.basename(shortPath).toLowerCase() === releaseName.toLowerCase()
    || !path.basename(shortPath).includes('~')) {
    t.skip('测试卷未为临时 runtime 目录生成 8.3 短名。')
    return
  }
  assert.equal(await validateOwnedRuntime(shortPath, releases), path.resolve(shortPath))
})

test('owned runtime validation accepts the configured real short-alias path', {
  skip: process.env.TRADELOOM_DSH_TEST_RUNTIME_ALIAS ? false : '未提供只读 pinned runtime 8.3 alias。',
}, async () => {
  assert.equal(await validateOwnedRuntime(process.env.TRADELOOM_DSH_TEST_RUNTIME_ALIAS), path.resolve(process.env.TRADELOOM_DSH_TEST_RUNTIME_ALIAS))
})

test('receipt writer and verifier accept an owned runtime under the real short-alias releases root', {
  skip: process.env.TRADELOOM_DSH_TEST_RUNTIME_ALIAS ? false : '未提供只读 pinned runtime 8.3 alias。',
}, async t => {
  const releasesAlias = path.dirname(process.env.TRADELOOM_DSH_TEST_RUNTIME_ALIAS)
  assert.equal(await sameDirectoryIdentity(releasesAlias, trustedReleaseRoot), true)
  await assertNoReparseAncestors(releasesAlias, path.parse(releasesAlias).root)
  const runtime = path.join(releasesAlias, `receipt-alias-fixture-${Date.now()}`)
  assert.equal(await sameDirectoryIdentity(path.dirname(runtime), trustedReleaseRoot), true)
  t.after(() => rm(runtime, { recursive: true, force: true }))
  await mkdir(path.join(runtime, 'apps/desktop/lib'), { recursive: true })
  await mkdir(path.join(runtime, 'apps/desktop-host/lib'), { recursive: true })
  await writeFile(path.join(runtime, runtimeMarkerName), runtimeMarkerContents)
  const compiledFiles = {}
  for (const relative of desktopReceiptFiles) {
    const bytes = `alias-fixture:${relative}`
    await writeFile(path.join(runtime, relative), bytes)
    compiledFiles[relative] = sha(bytes)
  }
  const lockPath = new URL('../../../integrations/dsh/patches/patches.lock.json', import.meta.url)
  const pinnedLock = JSON.parse(await readFile(lockPath, 'utf8'))
  await writeDesktopBuildReceipt({ runtimePath: runtime, releaseRoot: trustedReleaseRoot, lock: pinnedLock,
    runtimeMarker: runtimeMarkerContents, validateOwnedRuntime, buildEvidence: {
      patchesApplied: true, officialBuildExitCode: 0, sourceCommit: pinnedLock.upstream.commit,
      patchSetSha256: patchSetDigest(pinnedLock.patches), builder: 'launcher-alias-test-fixture',
    } })
  assert.equal((await verifyDesktopBuildReceipt(runtime, pinnedLock, trustedReleaseRoot)).sourceCommit, pinnedLock.upstream.commit)
})

test('foreign same-HEAD clone without the runtime ownership marker is rejected before its sentinel changes', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-runtime-foreign-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const releases = path.join(temp, 'releases')
  const foreign = path.join(releases, 'foreign-clone')
  await mkdir(releases, { recursive: true })
  const reference = path.join(workspaceRoot, 'research/references/deepseek-harness-v0.2.1-rc.3-readonly')
  execFileSync('git', ['clone', '--shared', '--no-checkout', reference, foreign], { stdio: 'pipe' })
  execFileSync('git', ['-C', foreign, 'checkout', '--detach', lock.upstream.commit], { stdio: 'pipe' })
  const sentinel = path.join(foreign, 'sentinel.txt')
  await writeFile(sentinel, 'untouched\n')
  await assert.rejects(validateOwnedRuntime(foreign), /固定 TradeLoom releases 根/)
  await assert.rejects(validateOwnedRuntime(foreign, releases), /ownership marker/)
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched\n')
})

test('runtime junction is rejected before reading its target marker', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-runtime-junction-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const releases = path.join(temp, 'releases')
  const foreign = path.join(temp, 'foreign')
  await mkdir(releases)
  await mkdir(foreign)
  const sentinel = path.join(foreign, 'sentinel.txt')
  await writeFile(sentinel, 'untouched\n')
  const junction = path.join(releases, 'redirected')
  try { await symlink(foreign, junction, 'junction') }
  catch (error) { if (error.code === 'EPERM') return; throw error }
  await assert.rejects(validateOwnedRuntime(junction, releases), /链接路径/)
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched\n')
})

test('partial bundle destination fails closed when a required file is missing', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-partial-bundle-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const destination = path.join(temp, 'bundle')
  await mkdir(destination)
  await writeFile(path.join(destination, 'package.json'), '{}')
  await assert.rejects(bundleDestinationIsCurrent(destination, '0'.repeat(64), ['package.json', 'client.js']), /ENOENT/)
})

test('desktop build receipt binds pinned patchset and compiled main/host hashes', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-desktop-receipt-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const releases = path.join(temp, 'releases')
  const runtime = path.join(releases, 'fixture-release')
  await mkdir(runtime, { recursive: true })
  await writeFile(path.join(runtime, runtimeMarkerName), runtimeMarkerContents)
  const compiledFiles = {}
  for (const [index, relative] of desktopReceiptFiles.entries()) {
    const file = path.join(runtime, relative)
    await mkdir(path.dirname(file), { recursive: true })
    const bytes = `compiled-${index}`
    await writeFile(file, bytes)
    compiledFiles[relative] = sha(bytes)
  }
  await writeFile(path.join(runtime, desktopReceiptName), JSON.stringify({
    schemaVersion: 1,
    sourceCommit: lock.upstream.commit,
    runtimeMarker: runtimeMarkerContents,
    patchSetSha256: expectedPatchSetDigest(lock.patches),
    compiledFiles,
  }))
  assert.deepEqual(await verifyDesktopBuildReceipt(runtime, lock, releases), { schemaVersion: 1, sourceCommit: lock.upstream.commit,
    runtimeMarker: runtimeMarkerContents, patchSetSha256: expectedPatchSetDigest(lock.patches), compiledFiles })
  await writeFile(path.join(runtime, desktopReceiptFiles[0]), 'stale compiled desktop')
  await assert.rejects(verifyDesktopBuildReceipt(runtime, lock, releases), /compiled desktop hash/)
})

test('desktop receipt rejects a linked compiled parent before reading the foreign target', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-desktop-parent-link-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const releases = path.join(temp, 'releases')
  const runtime = path.join(releases, 'fixture-release')
  const foreign = path.join(temp, 'foreign-lib')
  await mkdir(path.join(runtime, 'apps', 'desktop'), { recursive: true })
  await mkdir(foreign)
  await writeFile(path.join(runtime, runtimeMarkerName), runtimeMarkerContents)
  const sentinel = path.join(foreign, 'main.js')
  await writeFile(sentinel, 'must-not-be-read')
  try { await symlink(foreign, path.join(runtime, 'apps', 'desktop', 'lib'), 'junction') }
  catch (error) { if (error.code === 'EPERM') return; throw error }
  const compiledFiles = Object.fromEntries(desktopReceiptFiles.map(file => [file, sha('foreign')]))
  await writeFile(path.join(runtime, desktopReceiptName), JSON.stringify({
    schemaVersion: 1, sourceCommit: lock.upstream.commit, runtimeMarker: runtimeMarkerContents,
    patchSetSha256: expectedPatchSetDigest(lock.patches), compiledFiles,
  }))
  await assert.rejects(verifyDesktopBuildReceipt(runtime, lock, releases), /路径含链接祖先/)
  assert.equal(await readFile(sentinel, 'utf8'), 'must-not-be-read')
})

test('native artifact validator selection binds reviewed receipt and node bytes', async t => {
  const { resolveNativeArtifactValidator, nativeArtifactNodeRelative } = await import('../desktop-receipt.mjs')
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-native-node-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const releases = path.join(temp, 'releases'), runtime = path.join(releases, 'owned')
  await mkdir(runtime, { recursive: true }); await writeFile(path.join(runtime, runtimeMarkerName), runtimeMarkerContents)
  const compiledFiles = {}
  for (const [i, relative] of desktopReceiptFiles.entries()) { const p = path.join(runtime, relative); await mkdir(path.dirname(p), {recursive:true}); await writeFile(p, `file-${i}`); compiledFiles[relative]=sha(`file-${i}`) }
  const receipt = JSON.stringify({schemaVersion:1,sourceCommit:lock.upstream.commit,runtimeMarker:runtimeMarkerContents,patchSetSha256:expectedPatchSetDigest(lock.patches),compiledFiles})
  await writeFile(path.join(runtime,desktopReceiptName),receipt)
  const binary=path.join(runtime,...nativeArtifactNodeRelative.split('/')); await mkdir(path.dirname(binary),{recursive:true}); await writeFile(binary,'node fixture')
  const candidate={...lock,nativeArtifactValidator:{receiptSha256:sha(receipt),nodeRelativePath:nativeArtifactNodeRelative,nodeSha256:sha('node fixture')}}
  const valid=await resolveNativeArtifactValidator(runtime,candidate,releases); assert.equal(valid.available,true); assert.equal(valid.nodePath,binary)
  assert.equal((await resolveNativeArtifactValidator(runtime,lock,releases)).reason,'not_configured')
  for(const bad of [{...candidate.nativeArtifactValidator,receiptSha256:'0'.repeat(64)},{...candidate.nativeArtifactValidator,nodeSha256:'0'.repeat(64)},{...candidate.nativeArtifactValidator,nodeRelativePath:'../escape'}]) assert.equal((await resolveNativeArtifactValidator(runtime,{...lock,nativeArtifactValidator:bad},releases)).available,false)
  await rm(binary); assert.equal((await resolveNativeArtifactValidator(runtime,candidate,releases)).available,false)
  const outside=path.join(temp,'outside'); await mkdir(outside); await writeFile(path.join(outside,'node.exe'),'node fixture')
  await rm(path.dirname(binary),{recursive:true}); try { await symlink(outside,path.dirname(binary),'junction') } catch (error) { if (error.code === 'EPERM') return; throw error }
  assert.equal((await resolveNativeArtifactValidator(runtime,candidate,releases)).available,false)
})

test('explicit desktop build lock rejects relative, invalid and linked files', async t => {
  const { loadDesktopBuildLock } = await import('../desktop-receipt.mjs')
  const temp = await mkdtemp(path.join(os.tmpdir(),'tradeloom-lock-select-'))
  t.after(() => rm(temp,{recursive:true,force:true}))
  const file=path.join(temp,'lock.json'); await writeFile(file,JSON.stringify(lock))
  assert.deepEqual(await loadDesktopBuildLock(file),lock)
  await assert.rejects(loadDesktopBuildLock('relative.json'))
  await assert.rejects(loadDesktopBuildLock(path.join(temp,'missing.json')))
  await writeFile(file,'{}'); await assert.rejects(loadDesktopBuildLock(file),/格式无效/)
  const foreign=path.join(temp,'foreign'); await mkdir(foreign); await writeFile(path.join(foreign,'lock.json'),JSON.stringify(lock))
  const link=path.join(temp,'link'); try { await symlink(foreign,link,'junction') } catch(e) { if(e.code==='EPERM') return; throw e }
  await assert.rejects(loadDesktopBuildLock(path.join(link,'lock.json')))
})
