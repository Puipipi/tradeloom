import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { bundleDestinationIsCurrent, runtimeMarkerContents, runtimeMarkerName, validateOwnedRuntime } from '../prepare-profile.mjs'
import { desktopReceiptFiles, desktopReceiptName, expectedPatchSetDigest, verifyDesktopBuildReceipt } from '../desktop-receipt.mjs'

const lock = { upstream: { commit: '687f282e8625c6b8d11ff58211a90524be2e4317' }, patches: { 'one.patch': 'a'.repeat(64) } }
const sha = value => createHash('sha256').update(value).digest('hex')

test('foreign same-HEAD clone without the runtime ownership marker is rejected before its sentinel changes', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-runtime-foreign-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const releases = path.join(temp, 'releases')
  const foreign = path.join(releases, 'foreign-clone')
  await mkdir(releases, { recursive: true })
  const reference = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../workspace/research/references/deepseek-harness')
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
