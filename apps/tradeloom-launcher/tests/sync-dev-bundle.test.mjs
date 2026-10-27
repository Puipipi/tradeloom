import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { assertNoReparseAncestors, hashTree, packageName, profileBundles, sameDirectoryIdentity, trustedReleaseRoot } from '../prepare-profile.mjs'
import { ensureOwnedHome, launcherPipeName, reserveNamedPipe } from '../core.mjs'
import { syncDevBundle, syncDevBundleExclusive } from '../sync-dev-bundle.mjs'
import { prepareProfile } from '../prepare-profile.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

async function fixture(t, runtimeParent) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-sync-dev-bundle-'))
  const runtime = runtimeParent ? path.join(runtimeParent, `sync-fixture-${path.basename(root)}`) : path.join(root, 'runtime')
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
    if (runtimeParent) await rm(runtime, { recursive: true, force: true })
  })
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
    schema: 1, runtime: await realpath(runtime), packageName, bundleHash: oldHash, profile: 'tradeloom',
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

async function nextRuntimeFixture(fx, name = 'runtime-next') {
  const runtime = path.join(fx.root, name)
  await mkdir(path.join(runtime, 'apps', 'cli', 'lib'), { recursive: true })
  await mkdir(path.join(runtime, 'packages', 'boot', 'app-boot', 'lib'), { recursive: true })
  await writeFile(path.join(runtime, 'apps', 'cli', 'package.json'), '{}')
  await writeFile(path.join(runtime, 'apps', 'cli', 'lib', 'bin.js'), '')
  await writeFile(path.join(runtime, 'packages', 'boot', 'app-boot', 'package.json'), '{"type":"module"}')
  await writeFile(path.join(runtime, 'packages', 'boot', 'app-boot', 'lib', 'index.js'), 'export function initProfile() {}\n')
  await writeFile(path.join(runtime, '.tradeloom-runtime-owned'), 'new-runtime-sentinel')
  await writeFile(path.join(runtime, '.tradeloom-desktop-build-receipt.json'), 'new-receipt-sentinel')
  return { runtime, runtimeBundle: path.join(runtime, 'node_modules', ...packageName.split('/')) }
}

async function desktopMigrationFixture(t) {
  const fx = await fixture(t)
  const previousProfile = fx.profileDir
  const previousRecord = path.join(fx.home, 'tradeloom-launcher-tradeloom.json')
  const profileDir = path.join(fx.home, 'profiles', 'desktop')
  const profileBundle = path.join(profileDir, 'node_modules', ...packageName.split('/'))
  await rm(previousProfile, { recursive: true, force: true })
  await rm(previousRecord, { force: true })
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: profileBundles } } }) + '\n')
  await mkdir(path.dirname(profileBundle), { recursive: true })
  await cp(fx.source, profileBundle, { recursive: true })
  await writeFile(path.join(profileDir, 'sessions.json'), 'desktop-session-sentinel')
  await writeFile(path.join(fx.home, 'tradeloom-launcher-desktop.json'), JSON.stringify({
    schema: 1, runtime: await realpath(fx.runtime), packageName, bundleHash: fx.oldHash, profile: 'desktop',
  }, null, 2) + '\n')
  return { ...fx, profileDir, profileBundle, recordPath: path.join(fx.home, 'tradeloom-launcher-desktop.json') }
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

test('sync accepts its canonical runtime record when the selected path uses a real 8.3 parent alias', {
  skip: process.env.TRADELOOM_DSH_TEST_RUNTIME_ALIAS ? false : '未提供只读 pinned runtime 8.3 alias。',
}, async t => {
  const releasesAlias = path.dirname(process.env.TRADELOOM_DSH_TEST_RUNTIME_ALIAS)
  assert.equal(await sameDirectoryIdentity(releasesAlias, trustedReleaseRoot), true)
  await assertNoReparseAncestors(releasesAlias, path.parse(releasesAlias).root)
  const fx = await fixture(t, releasesAlias)
  await writeFile(path.join(fx.source, 'roles.js'), 'export const version = "alias-sync"\n')

  const result = await syncDevBundle({ runtimePath: fx.runtime, home: fx.home, mode: 'web', source: fx.source,
    validateRuntime: fx.validateRuntime, transactionId: 'alias-runtime-record' })
  assert.equal(result.changed, true)
  assert.equal(await hashTree(fx.runtimeBundle, ['package.json', 'roles.js']), result.bundleHash)
  assert.equal(await hashTree(fx.profileBundle, ['package.json', 'roles.js']), result.bundleHash)
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

test('cross-runtime sync remains refused unless the prior runtime is explicitly supplied', async t => {
  const fx = await fixture(t)
  const next = await nextRuntimeFixture(fx)
  await writeFile(path.join(fx.source, 'roles.js'), 'export const version = "candidate8"\n')

  await assert.rejects(syncDevBundle({ runtimePath: next.runtime, home: fx.home, mode: 'web', source: fx.source,
    validateRuntime: fx.validateRuntime, transactionId: 'migration-default-refused' }), /记录与所选自有 profile 不匹配/)
  assert.equal(await readFile(path.join(fx.runtimeBundle, 'roles.js'), 'utf8'), 'export const version = "old"\n')
  await assert.rejects(readFile(path.join(next.runtimeBundle, 'roles.js'), 'utf8'), { code: 'ENOENT' })
})

test('explicit owned runtime migration updates only the new runtime and prepare reuses it', async t => {
  const fx = await fixture(t)
  const next = await nextRuntimeFixture(fx)
  await writeFile(path.join(fx.source, 'roles.js'), 'export const version = "candidate8"\n')
  await writeFile(path.join(fx.profileDir, 'sessions.json'), 'existing-session-data')

  const result = await syncDevBundleExclusive({ runtimePath: next.runtime, previousRuntimePath: fx.runtime,
    home: fx.home, mode: 'web', source: fx.source, validateRuntime: fx.validateRuntime,
    transactionId: 'migration-success' })
  const currentHash = await hashTree(fx.source, ['package.json', 'roles.js'])
  assert.equal(result.runtime, path.resolve(next.runtime))
  assert.equal(result.bundleHash, currentHash)
  assert.equal(await hashTree(next.runtimeBundle, ['package.json', 'roles.js']), currentHash)
  assert.equal(await hashTree(fx.profileBundle, ['package.json', 'roles.js']), currentHash)
  assert.equal(await readFile(path.join(fx.runtimeBundle, 'roles.js'), 'utf8'), 'export const version = "old"\n')
  const record = JSON.parse(await readFile(path.join(fx.home, 'tradeloom-launcher-tradeloom.json'), 'utf8'))
  assert.equal(record.runtime, await realpath(next.runtime))

  const prepared = await prepareProfile({ runtimePath: next.runtime, home: fx.home,
    agentsHome: path.join(fx.root, 'agents'), workspace: path.join(fx.root, 'workspace'),
    mode: 'web', source: fx.source, validateRuntimeFn: fx.validateRuntime, requirePinnedCommit: false })
  assert.equal(prepared.bundleHash, currentHash)
  assert.equal(await readFile(path.join(fx.profileDir, 'sessions.json'), 'utf8'), 'existing-session-data')
  assert.equal(await readFile(path.join(next.runtime, '.tradeloom-runtime-owned'), 'utf8'), 'new-runtime-sentinel')
  assert.equal(await readFile(path.join(next.runtime, '.tradeloom-desktop-build-receipt.json'), 'utf8'), 'new-receipt-sentinel')
})

test('explicit runtime migration rolls back a missing destination bundle when record commit fails', async t => {
  const fx = await fixture(t)
  const next = await nextRuntimeFixture(fx)
  await writeFile(path.join(fx.source, 'roles.js'), 'export const version = "candidate8"\n')
  const beforeProfile = await readFile(path.join(fx.profileBundle, 'roles.js'), 'utf8')
  const beforeRecord = await readFile(path.join(fx.home, 'tradeloom-launcher-tradeloom.json'), 'utf8')

  await assert.rejects(syncDevBundle({ runtimePath: next.runtime, previousRuntimePath: fx.runtime,
    home: fx.home, mode: 'web', source: fx.source, validateRuntime: fx.validateRuntime,
    transactionId: 'migration-rollback', beforeRecordCommit: () => { throw new Error('injected migration commit failure') } }), /injected migration commit failure/)
  await assert.rejects(lstat(next.runtimeBundle), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(fx.profileBundle, 'roles.js'), 'utf8'), beforeProfile)
  assert.equal(await readFile(path.join(fx.home, 'tradeloom-launcher-tradeloom.json'), 'utf8'), beforeRecord)
  assert.equal(await readFile(path.join(fx.runtimeBundle, 'roles.js'), 'utf8'), 'export const version = "old"\n')
})

test('explicit runtime migration refuses a prior runtime bundle that differs from its record', async t => {
  const fx = await fixture(t)
  const next = await nextRuntimeFixture(fx)
  await writeFile(path.join(fx.runtimeBundle, 'roles.js'), 'unrecorded-old-runtime-content\n')
  await writeFile(path.join(fx.source, 'roles.js'), 'export const version = "candidate8"\n')

  await assert.rejects(syncDevBundle({ runtimePath: next.runtime, previousRuntimePath: fx.runtime,
    home: fx.home, mode: 'web', source: fx.source, validateRuntime: fx.validateRuntime,
    transactionId: 'migration-old-hash-refused' }), /迁移来源 bundle 与记录版本不一致/)
  await assert.rejects(lstat(next.runtimeBundle), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(fx.runtimeBundle, 'roles.js'), 'utf8'), 'unrecorded-old-runtime-content\n')
})

test('explicit runtime migration accepts a destination already at the current source hash', async t => {
  const fx = await fixture(t)
  const next = await nextRuntimeFixture(fx)
  await writeFile(path.join(fx.source, 'roles.js'), 'export const version = "candidate8"\n')
  await mkdir(path.dirname(next.runtimeBundle), { recursive: true })
  await cp(fx.source, next.runtimeBundle, { recursive: true })

  const result = await syncDevBundle({ runtimePath: next.runtime, previousRuntimePath: fx.runtime,
    home: fx.home, mode: 'web', source: fx.source, validateRuntime: fx.validateRuntime,
    transactionId: 'migration-current-target' })
  assert.equal(result.changed, true)
  assert.equal(await hashTree(next.runtimeBundle, ['package.json', 'roles.js']), result.bundleHash)
})

test('desktop migration updates only bundle copies and runtime record while preserving session state', async t => {
  const fx = await desktopMigrationFixture(t)
  const next = await nextRuntimeFixture(fx)
  await writeFile(path.join(fx.source, 'roles.js'), 'export const version = "candidate9"\n')
  const beforeProfileManifest = await readFile(path.join(fx.profileDir, 'package.json'), 'utf8')
  const result = await syncDevBundleExclusive({
    runtimePath: next.runtime, previousRuntimePath: fx.runtime, home: fx.home, mode: 'desktop', source: fx.source,
    validateRuntime: fx.validateRuntime, validatePreviousRuntime: fx.validateRuntime,
    expectedPreviousBundleHash: fx.oldHash, transactionId: 'desktop-rc2-migration',
  })
  const currentHash = await hashTree(fx.source, ['package.json', 'roles.js'])
  assert.equal(result.bundleHash, currentHash)
  assert.equal(await hashTree(next.runtimeBundle, ['package.json', 'roles.js']), currentHash)
  assert.equal(await hashTree(fx.profileBundle, ['package.json', 'roles.js']), currentHash)
  assert.equal(await readFile(path.join(fx.runtimeBundle, 'roles.js'), 'utf8'), 'export const version = "old"\n')
  const record = JSON.parse(await readFile(fx.recordPath, 'utf8'))
  assert.equal(record.runtime, await realpath(next.runtime))
  assert.equal(record.bundleHash, currentHash)
  assert.equal(await readFile(path.join(fx.profileDir, 'sessions.json'), 'utf8'), 'desktop-session-sentinel')
  assert.equal(await readFile(path.join(fx.profileDir, 'package.json'), 'utf8'), beforeProfileManifest)
  assert.equal(await readFile(path.join(fx.runtime, '.tradeloom-desktop-build-receipt.json'), 'utf8'), 'receipt-sentinel')
  await assert.rejects(lstat(path.join(fx.home, 'tradeloom-launcher-tradeloom.json')), { code: 'ENOENT' })
})

test('desktop migration rejects a previous runtime not bound by the desktop record', async t => {
  const fx = await desktopMigrationFixture(t)
  const next = await nextRuntimeFixture(fx)
  const unrelated = path.join(fx.root, 'unrelated-runtime')
  await mkdir(unrelated)
  await assert.rejects(syncDevBundle({
    runtimePath: next.runtime, previousRuntimePath: unrelated, home: fx.home, mode: 'desktop', source: fx.source,
    validateRuntime: fx.validateRuntime, validatePreviousRuntime: fx.validateRuntime,
    expectedPreviousBundleHash: fx.oldHash, transactionId: 'desktop-wrong-previous',
  }), /记录与所选自有 profile 不匹配/)
  await assert.rejects(lstat(next.runtimeBundle), { code: 'ENOENT' })
})

test('desktop migration refuses a profile record outside the fixed prior bundle hash', async t => {
  const fx = await desktopMigrationFixture(t)
  const next = await nextRuntimeFixture(fx)
  await assert.rejects(syncDevBundle({
    runtimePath: next.runtime, previousRuntimePath: fx.runtime, home: fx.home, mode: 'desktop', source: fx.source,
    validateRuntime: fx.validateRuntime, validatePreviousRuntime: fx.validateRuntime,
    expectedPreviousBundleHash: '0'.repeat(64), transactionId: 'desktop-wrong-bundle-hash',
  }), /不属于已知先前 bundle/)
  await assert.rejects(lstat(next.runtimeBundle), { code: 'ENOENT' })
})

test('desktop migration restores old bindings after a failed record commit', async t => {
  const fx = await desktopMigrationFixture(t)
  const next = await nextRuntimeFixture(fx)
  const beforeRecord = await readFile(fx.recordPath, 'utf8')
  const beforeProfile = await readFile(path.join(fx.profileBundle, 'roles.js'), 'utf8')
  await assert.rejects(syncDevBundle({
    runtimePath: next.runtime, previousRuntimePath: fx.runtime, home: fx.home, mode: 'desktop', source: fx.source,
    validateRuntime: fx.validateRuntime, validatePreviousRuntime: fx.validateRuntime,
    expectedPreviousBundleHash: fx.oldHash, transactionId: 'desktop-rollback',
    beforeRecordCommit: () => { throw new Error('injected desktop migration commit failure') },
  }), /injected desktop migration commit failure/)
  await assert.rejects(lstat(next.runtimeBundle), { code: 'ENOENT' })
  assert.equal(await readFile(fx.recordPath, 'utf8'), beforeRecord)
  assert.equal(await readFile(path.join(fx.profileBundle, 'roles.js'), 'utf8'), beforeProfile)
  assert.equal(await readFile(path.join(fx.runtimeBundle, 'roles.js'), 'utf8'), 'export const version = "old"\n')
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

test('sync refreshes client entry revision for lazy chunk changes without changing entry bytes', async t => {
  const fx = await fixture(t)
  const files = ['package.json', 'roles.js', 'client.js', 'client.workflow.js']
  for (const dir of [fx.source, fx.runtimeBundle, fx.profileBundle]) {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: packageName, files: files.slice(1) }))
    await writeFile(path.join(dir, 'client.js'), 'entry-sentinel')
    await writeFile(path.join(dir, 'client.workflow.js'), 'old-chunk')
    const { utimes } = await import('node:fs/promises')
    await utimes(path.join(dir, 'client.js'), new Date('2000-01-01'), new Date('2000-01-01'))
  }
  const oldHash = await hashTree(fx.source, files)
  const recordPath = path.join(fx.home, 'tradeloom-launcher-tradeloom.json')
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  await writeFile(recordPath, JSON.stringify({ ...record, bundleHash: oldHash }))
  await writeFile(path.join(fx.source, 'client.workflow.js'), 'new-chunk')
  await syncDevBundle({ runtimePath: fx.runtime, home: fx.home, source: fx.source, validateRuntime: fx.validateRuntime })
  for (const dir of [fx.runtimeBundle, fx.profileBundle]) {
    assert.equal(await readFile(path.join(dir, 'client.js'), 'utf8'), 'entry-sentinel')
    assert.equal(await readFile(path.join(dir, 'client.workflow.js'), 'utf8'), 'new-chunk')
    assert.ok((await lstat(path.join(dir, 'client.js'))).mtimeMs > Date.parse('2020-01-01'))
    assert.equal(await hashTree(dir, files), await hashTree(fx.source, files))
  }
})
