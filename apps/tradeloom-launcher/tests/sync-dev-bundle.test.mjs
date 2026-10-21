import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { hashTree, packageName, profileBundles } from '../prepare-profile.mjs'
import { ensureOwnedHome, launcherPipeName, reserveNamedPipe } from '../core.mjs'
import { syncDevBundle, syncDevBundleExclusive } from '../sync-dev-bundle.mjs'
import { prepareProfile } from '../prepare-profile.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-sync-dev-bundle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = path.join(root, 'runtime')
  const home = path.join(root, 'home')
  const source = path.join(root, 'source')
  const profileDir = path.join(home, 'profiles', 'tradeloom')
  const runtimeBundle = path.join(runtime, 'node_modules', ...packageName.split('/'))
  const profileBundle = path.join(profileDir, 'node_modules', ...packageName.split('/'))
  await ensureOwnedHome(home)
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: packageName, files: ['roles.js'] }) + '\n')
  await writeFile(path.join(source, 'roles.js'), 'export const version = "old"\n')
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: profileBundles } } }) + '\n')
  await mkdir(path.dirname(runtimeBundle), { recursive: true })
  await mkdir(path.dirname(profileBundle), { recursive: true })
  await cp(source, runtimeBundle, { recursive: true })
  await cp(source, profileBundle, { recursive: true })
  const oldHash = await hashTree(source, ['package.json', 'roles.js'])
  await writeFile(path.join(home, 'tradeloom-launcher-tradeloom.json'), JSON.stringify({
    schema: 1, runtime: path.resolve(runtime), packageName, bundleHash: oldHash, profile: 'tradeloom',
  }, null, 2) + '\n')
  await mkdir(path.join(runtime, 'apps', 'cli', 'lib'), { recursive: true })
  await mkdir(path.join(runtime, 'packages', 'boot', 'app-boot', 'lib'), { recursive: true })
  await writeFile(path.join(runtime, 'apps', 'cli', 'package.json'), '{}')
  await writeFile(path.join(runtime, 'apps', 'cli', 'lib', 'bin.js'), '')
  await writeFile(path.join(runtime, 'packages', 'boot', 'app-boot', 'package.json'), '{"type":"module"}')
  await writeFile(path.join(runtime, 'packages', 'boot', 'app-boot', 'lib', 'index.js'), 'export function initProfile() {}\n')
  await writeFile(path.join(home, 'profiles', 'tradeloom', 'sessions.json'), 'session-sentinel')
  await writeFile(path.join(runtime, '.tradeloom-runtime-owned'), 'runtime-sentinel')
  await writeFile(path.join(runtime, '.tradeloom-desktop-build-receipt.json'), 'receipt-sentinel')
  const validateRuntime = async value => path.resolve(value)
  return { root, runtime, home, source, runtimeBundle, profileBundle, profileDir, oldHash, validateRuntime }
}

test('explicit sync recovers a source bundle change and leaves profile/session/runtime receipt data intact', async t => {
  const fx = await fixture(t)
  await writeFile(path.join(fx.source, 'roles.js'), 'export const version = "new"\n')
  await assert.rejects(prepareProfile({ runtimePath: fx.runtime, home: fx.home, agentsHome: path.join(fx.root, 'agents'), workspace: path.join(fx.root, 'workspace'), mode: 'web', source: fx.source, validateRuntimeFn: fx.validateRuntime, requirePinnedCommit: false }), /不一致|内容不匹配/)

  const result = await syncDevBundleExclusive({ runtimePath: fx.runtime, home: fx.home, mode: 'web', source: fx.source, validateRuntime: fx.validateRuntime, transactionId: 'success' })
  const currentHash = await hashTree(fx.source, ['package.json', 'roles.js'])
  assert.equal(result.bundleHash, currentHash)
  assert.equal(await hashTree(fx.runtimeBundle, ['package.json', 'roles.js']), currentHash)
  assert.equal(await hashTree(fx.profileBundle, ['package.json', 'roles.js']), currentHash)
  assert.equal(JSON.parse(await readFile(path.join(fx.home, 'tradeloom-launcher-tradeloom.json'), 'utf8')).bundleHash, currentHash)
  const prepared = await prepareProfile({ runtimePath: fx.runtime, home: fx.home, agentsHome: path.join(fx.root, 'agents'), workspace: path.join(fx.root, 'workspace'), mode: 'web', source: fx.source, validateRuntimeFn: fx.validateRuntime, requirePinnedCommit: false })
  assert.equal(prepared.bundleHash, currentHash)
  assert.equal(await readFile(path.join(fx.profileDir, 'sessions.json'), 'utf8'), 'session-sentinel')
  assert.equal(await readFile(path.join(fx.runtime, '.tradeloom-runtime-owned'), 'utf8'), 'runtime-sentinel')
  assert.equal(await readFile(path.join(fx.runtime, '.tradeloom-desktop-build-receipt.json'), 'utf8'), 'receipt-sentinel')
  assert.deepEqual(JSON.parse(await readFile(path.join(fx.profileDir, 'package.json'), 'utf8')).dsh.profile.bundles, profileBundles)
})

test('sync accepts a new nested source package file and preserves profile session and runtime receipt', async t => {
  const fx = await fixture(t)
  await writeFile(path.join(fx.source, 'package.json'), JSON.stringify({ name: packageName, files: ['roles.js', 'agents/demo.js'] }) + '\n')
  await writeFile(path.join(fx.source, 'roles.js'), 'export const version = "expanded"\n')
  await mkdir(path.join(fx.source, 'agents'), { recursive: true })
  await writeFile(path.join(fx.source, 'agents', 'demo.js'), 'export const agent = "new module"\n')

  const result = await syncDevBundleExclusive({ runtimePath: fx.runtime, home: fx.home, mode: 'web', source: fx.source,
    validateRuntime: fx.validateRuntime, transactionId: 'new-file-list' })
  const files = ['package.json', 'roles.js', 'agents/demo.js']
  const expectedHash = await hashTree(fx.source, files)
  assert.equal(result.bundleHash, expectedHash)
  assert.equal(await hashTree(fx.runtimeBundle, files), expectedHash)
  assert.equal(await hashTree(fx.profileBundle, files), expectedHash)
  assert.equal(JSON.parse(await readFile(path.join(fx.home, 'tradeloom-launcher-tradeloom.json'), 'utf8')).bundleHash, expectedHash)
  assert.equal(await readFile(path.join(fx.runtimeBundle, 'agents', 'demo.js'), 'utf8'), 'export const agent = "new module"\n')
  assert.equal(await readFile(path.join(fx.profileBundle, 'agents', 'demo.js'), 'utf8'), 'export const agent = "new module"\n')
  assert.equal(await readFile(path.join(fx.profileDir, 'sessions.json'), 'utf8'), 'session-sentinel')
  assert.equal(await readFile(path.join(fx.runtime, '.tradeloom-desktop-build-receipt.json'), 'utf8'), 'receipt-sentinel')
})

test('failed record commit restores both bundle copies and the original launcher record', async t => {
  const fx = await fixture(t)
  await writeFile(path.join(fx.source, 'roles.js'), 'export const version = "new"\n')
  const beforeRuntime = await readFile(path.join(fx.runtimeBundle, 'roles.js'), 'utf8')
  const beforeProfile = await readFile(path.join(fx.profileBundle, 'roles.js'), 'utf8')
  const beforeRecord = await readFile(path.join(fx.home, 'tradeloom-launcher-tradeloom.json'), 'utf8')
  await assert.rejects(syncDevBundle({ runtimePath: fx.runtime, home: fx.home, mode: 'web', source: fx.source, validateRuntime: fx.validateRuntime, transactionId: 'rollback', beforeRecordCommit: () => { throw new Error('injected commit failure') } }), /injected commit failure/)
  assert.equal(await readFile(path.join(fx.runtimeBundle, 'roles.js'), 'utf8'), beforeRuntime)
  assert.equal(await readFile(path.join(fx.profileBundle, 'roles.js'), 'utf8'), beforeProfile)
  assert.equal(await readFile(path.join(fx.home, 'tradeloom-launcher-tradeloom.json'), 'utf8'), beforeRecord)
})

test('exclusive development sync refuses the running launcher home named pipe', async t => {
  const fx = await fixture(t)
  const owner = await reserveNamedPipe(launcherPipeName(fx.home))
  let called = false
  try {
    await assert.rejects(syncDevBundleExclusive({ runtimePath: fx.runtime, home: fx.home, mode: 'web' }, { synchronize: async () => { called = true } }))
  } finally { await new Promise(resolve => owner.close(resolve)) }
  assert.equal(called, false)
})

test('sync refuses an unrecognized destination hash', async t => {
  const fx = await fixture(t)
  await writeFile(path.join(fx.runtimeBundle, 'roles.js'), 'unexpected\n')
  await writeFile(path.join(fx.source, 'roles.js'), 'export const version = "new"\n')
  await assert.rejects(syncDevBundle({ runtimePath: fx.runtime, home: fx.home, mode: 'web', source: fx.source, validateRuntime: fx.validateRuntime, transactionId: 'unknown' }), /拒绝覆盖/)
  assert.equal(await readFile(path.join(fx.runtimeBundle, 'roles.js'), 'utf8'), 'unexpected\n')
  assert.equal(await readFile(path.join(fx.profileBundle, 'roles.js'), 'utf8'), 'export const version = "old"\n')
})
