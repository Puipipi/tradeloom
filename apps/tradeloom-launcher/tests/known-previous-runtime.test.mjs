import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import {
  knownPreviousCompiledFiles, knownPreviousPatchSetSha256, knownPreviousRuntimeCommit,
  knownPreviousRuntime10, knownPreviousRuntime11, knownPreviousRuntime12, knownPreviousRuntime13, knownPreviousRuntime14, knownPreviousRuntime15, knownPreviousRuntime16, knownPreviousRuntimeIdentity,
  knownPreviousRuntimeMarker, knownPreviousRuntimeName, validateKnownPreviousRuntime,
} from '../known-previous-runtime.mjs'
import { sameDirectoryIdentity, trustedReleaseRoot } from '../prepare-profile.mjs'
import { verifyDesktopBuildReceipt } from '../desktop-receipt.mjs'
import { patchSetDigest } from '../receipt-writer.mjs'

async function fixture(t, identity = {
  name: knownPreviousRuntimeName, commit: knownPreviousRuntimeCommit, marker: knownPreviousRuntimeMarker,
  patchSet: knownPreviousPatchSetSha256, compiledFiles: knownPreviousCompiledFiles, version: '0.2.1-rc.2',
}) {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-previous-runtime-'))
  const runtime = path.join(releaseRoot, identity.name)
  await mkdir(runtime)
  await writeFile(path.join(runtime, '.tradeloom-runtime-owned'), identity.marker)
  const files = {}
  for (const [relative, hash] of Object.entries(identity.compiledFiles)) {
    const file = path.join(runtime, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `compiled ${relative}\n`)
    files[relative] = hash
  }
  const evidence = {
    patchesApplied: true, officialBuildExitCode: 0, sourceCommit: identity.commit,
    patchSetSha256: identity.patchSet, sourceTargetsMatched: true,
  }
  await writeFile(path.join(runtime, '.tradeloom-desktop-build-receipt.json'), JSON.stringify({
    schemaVersion: 1, sourceCommit: identity.commit, runtimeMarker: identity.marker,
    patchSetSha256: identity.patchSet, compiledFiles: files,
    bootstrap: { schemaVersion: 1, buildEvidence: evidence },
  }))
  const manifest = path.join(runtime, 'apps/desktop/package.json')
  await mkdir(path.dirname(manifest), { recursive: true })
  await writeFile(manifest, JSON.stringify({ version: identity.version, dshDesktopAppId: 'cn.tradeloom.workbench' }))
  t.after(() => rm(releaseRoot, { recursive: true, force: true }))
  return { releaseRoot, runtime }
}

test('known previous runtime accepts the fixed desktop-8 identity and receipt', async t => {
  const fx = await fixture(t)
  const runtime = await validateKnownPreviousRuntime(fx.runtime, {
    releaseRoot: fx.releaseRoot,
    readHead: async () => knownPreviousRuntimeCommit,
    hashFile: async (_file, bytes) => {
      assert.ok(bytes instanceof Buffer)
      const relative = Object.keys(knownPreviousCompiledFiles).find(item => _file.endsWith(item.replaceAll('/', path.sep)))
      return knownPreviousCompiledFiles[relative]
    },
  })
  assert.equal(runtime, fx.runtime)
})

test('known previous runtime rejects a wrong pinned source commit', async t => {
  const fx = await fixture(t)
  await assert.rejects(validateKnownPreviousRuntime(fx.runtime, {
    releaseRoot: fx.releaseRoot,
    readHead: async () => 'a'.repeat(40),
  }), /Git commit 不匹配/)
})

test('known previous runtime rejects any other release directory before receipt checks', async t => {
  const fx = await fixture(t)
  const wrongPath = path.join(fx.releaseRoot, '0.2.1-rc.3-tradeloom-desktop-9')
  await assert.rejects(validateKnownPreviousRuntime(wrongPath, { releaseRoot: fx.releaseRoot }), /必须是已知且固定的 TradeLoom runtime/)
})

test('known previous runtime rejects a corrupted receipt compiled hash', async t => {
  const fx = await fixture(t)
  const receiptPath = path.join(fx.runtime, '.tradeloom-desktop-build-receipt.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  receipt.compiledFiles['apps/desktop/lib/main.js'] = '0'.repeat(64)
  await writeFile(receiptPath, JSON.stringify(receipt))
  await assert.rejects(validateKnownPreviousRuntime(fx.runtime, {
    releaseRoot: fx.releaseRoot,
    readHead: async () => knownPreviousRuntimeCommit,
    hashFile: async (_file, bytes) => {
      assert.ok(bytes instanceof Buffer)
      return knownPreviousCompiledFiles['apps/desktop/lib/main.js']
    },
  }), /receipt compiled hash 不匹配/)
})

test('known previous desktop-10 runtime validates its separate RC3 receipt identity', async t => {
  const fx = await fixture(t, knownPreviousRuntime10)
  const runtime = await validateKnownPreviousRuntime(fx.runtime, {
    releaseRoot: fx.releaseRoot,
    readHead: async () => knownPreviousRuntime10.commit,
    hashFile: async (_file, bytes) => {
      assert.ok(bytes instanceof Buffer)
      const relative = Object.keys(knownPreviousRuntime10.compiledFiles).find(item => _file.endsWith(item.replaceAll('/', path.sep)))
      return knownPreviousRuntime10.compiledFiles[relative]
    },
  })
  assert.equal(runtime, fx.runtime)
})

test('known previous desktop-11 runtime validates its pinned RC3 receipt and desktop bundle identity', async t => {
  assert.deepEqual(knownPreviousRuntime11, {
    name: '0.2.1-rc.3-tradeloom-desktop-11',
    commit: '1f81c047fc48fa190a683e469daa699857e9afe8',
    patchSet: '2da03698fc0242b540ccba7a2268ace72d2e495cfea020df6f43da7f74983eba',
    bundleHash: '782cdc08e453086c26aba6c0c93f2bfd850ac3bb005cba1ccd357fa65ec27dcd',
    compiledFiles: {
      'apps/desktop/lib/main.js': 'c39e1a101f2f560dcce647bae7817de316c0427977f50d67529a4ac21d0a5626',
      'apps/desktop-host/lib/index.js': '61896cd7416a9955b015e013a51b9a770272c68997fe2d9da92cb45508f4e59e',
    },
    version: '0.2.1-rc.3',
    requireSourceTargetsMatched: false,
    marker: 'tradeloom-dsh-runtime-v1\n1f81c047fc48fa190a683e469daa699857e9afe8\n',
  })
  const fx = await fixture(t, knownPreviousRuntime11)
  assert.equal(knownPreviousRuntimeIdentity(fx.runtime), knownPreviousRuntime11)
  const runtime = await validateKnownPreviousRuntime(fx.runtime, {
    releaseRoot: fx.releaseRoot,
    readHead: async () => knownPreviousRuntime11.commit,
    hashFile: async (_file, bytes) => {
      assert.ok(bytes instanceof Buffer)
      const relative = Object.keys(knownPreviousRuntime11.compiledFiles)
        .find(item => _file.endsWith(item.replaceAll('/', path.sep)))
      return knownPreviousRuntime11.compiledFiles[relative]
    },
  })
  assert.equal(runtime, fx.runtime)
})

test('known previous desktop-12 runtime validates its pinned RC3 receipt and desktop bundle identity', async t => {
  assert.deepEqual(knownPreviousRuntime12, {
    name: '0.2.1-rc.3-tradeloom-desktop-12',
    commit: '1f81c047fc48fa190a683e469daa699857e9afe8',
    patchSet: '44cef24abf17f8a86e149beb68164494045fb408681b2f3adf57291841761d60',
    bundleHash: '9c323a827bed65089d6fa2fc4edc4cc2ffe28e5f3fcb8fbe9878b7930191a8d5',
    compiledFiles: {
      'apps/desktop/lib/main.js': 'c79178f2d205d9d6bcbf7975d1598ab6278d4c41aaf76a05169183f3696049a8',
      'apps/desktop-host/lib/index.js': '61896cd7416a9955b015e013a51b9a770272c68997fe2d9da92cb45508f4e59e',
    },
    version: '0.2.1-rc.3',
    requireSourceTargetsMatched: false,
    marker: 'tradeloom-dsh-runtime-v1\n1f81c047fc48fa190a683e469daa699857e9afe8\n',
  })
  const fx = await fixture(t, knownPreviousRuntime12)
  assert.equal(knownPreviousRuntimeIdentity(fx.runtime), knownPreviousRuntime12)
  const runtime = await validateKnownPreviousRuntime(fx.runtime, {
    releaseRoot: fx.releaseRoot,
    readHead: async () => knownPreviousRuntime12.commit,
    hashFile: async (_file, bytes) => {
      assert.ok(bytes instanceof Buffer)
      const relative = Object.keys(knownPreviousRuntime12.compiledFiles)
        .find(item => _file.endsWith(item.replaceAll('/', path.sep)))
      return knownPreviousRuntime12.compiledFiles[relative]
    },
  })
  assert.equal(runtime, fx.runtime)
})

test('known previous desktop-14 runtime validates its receipt before migrating to the menu-fixed candidate', async t => {
  const fx = await fixture(t, knownPreviousRuntime14)
  assert.equal(knownPreviousRuntime14.name, '0.2.1-rc.3-tradeloom-desktop-14')
  assert.equal(knownPreviousRuntime14.patchSet, '0e99a89b8ece8963cd61228d1df226374872004d65d2bb63c259bb880359928c')
  assert.equal(knownPreviousRuntime14.bundleHash, '2e0c2f20391feb7f8583f59591df34b61585b5ee19437855bde0714d2c08b5fd')
  assert.equal(knownPreviousRuntimeIdentity(fx.runtime), knownPreviousRuntime14)
  const runtime = await validateKnownPreviousRuntime(fx.runtime, {
    releaseRoot: fx.releaseRoot,
    readHead: async () => knownPreviousRuntime14.commit,
    hashFile: async file => {
      const relative = Object.keys(knownPreviousRuntime14.compiledFiles).find(item => file.endsWith(item.replaceAll('/', path.sep)))
      return knownPreviousRuntime14.compiledFiles[relative]
    },
  })
  assert.equal(runtime, fx.runtime)
})

test('known previous desktop-13 runtime validates its pinned RC3 receipt and desktop bundle identity', async t => {
  assert.deepEqual(knownPreviousRuntime13, {
    name: '0.2.1-rc.3-tradeloom-desktop-13',
    commit: '1f81c047fc48fa190a683e469daa699857e9afe8',
    patchSet: 'fa80229664d903da9d246497642b7580ac63619d3d4fdc63aeef0efd5b3e2224',
    bundleHash: 'c7c1164f9fd8742ca4714e177806e26c9546d8249478a61b815a2d5537140b94',
    compiledFiles: {
      'apps/desktop/lib/main.js': '7f107d8e446519f9aa647f0b7eb9a1c331fad025c1302c2b17225fc8eddcf7ac',
      'apps/desktop-host/lib/index.js': '61896cd7416a9955b015e013a51b9a770272c68997fe2d9da92cb45508f4e59e',
    },
    version: '0.2.1-rc.3',
    requireSourceTargetsMatched: false,
    marker: 'tradeloom-dsh-runtime-v1\n1f81c047fc48fa190a683e469daa699857e9afe8\n',
  })
  const fx = await fixture(t, knownPreviousRuntime13)
  assert.equal(knownPreviousRuntimeIdentity(fx.runtime), knownPreviousRuntime13)
  const runtime = await validateKnownPreviousRuntime(fx.runtime, {
    releaseRoot: fx.releaseRoot,
    readHead: async () => knownPreviousRuntime13.commit,
    hashFile: async (_file, bytes) => {
      assert.ok(bytes instanceof Buffer)
      const relative = Object.keys(knownPreviousRuntime13.compiledFiles)
        .find(item => _file.endsWith(item.replaceAll('/', path.sep)))
      return knownPreviousRuntime13.compiledFiles[relative]
    },
  })
  assert.equal(runtime, fx.runtime)
})

test('known previous desktop-15 runtime validates its receipt before migrating to the native header and website candidate', async t => {
  const fx = await fixture(t, knownPreviousRuntime15)
  assert.equal(knownPreviousRuntime15.name, '0.2.1-rc.3-tradeloom-desktop-15')
  assert.equal(knownPreviousRuntime15.patchSet, '1325ce2b6e52985095a3d72073c58a1128e262585b4389fa342d1051600fc923')
  assert.equal(knownPreviousRuntime15.bundleHash, 'b00164b5e4954ed2a8918cd013768c8e93528f9c1867aa51811c8909ccd6e276')
  assert.equal(knownPreviousRuntimeIdentity(fx.runtime), knownPreviousRuntime15)
  const runtime = await validateKnownPreviousRuntime(fx.runtime, {
    releaseRoot: fx.releaseRoot,
    readHead: async () => knownPreviousRuntime15.commit,
    hashFile: async file => {
      const relative = Object.keys(knownPreviousRuntime15.compiledFiles).find(item => file.endsWith(item.replaceAll('/', path.sep)))
      return knownPreviousRuntime15.compiledFiles[relative]
    },
  })
  assert.equal(runtime, fx.runtime)
})

test('desktop-16 pinned receipt and actual bundle record validate against the published 20-patch lock', async t => {
  const runtime = path.join(trustedReleaseRoot, knownPreviousRuntime16.name)
  const receiptPath = path.join(runtime, '.tradeloom-desktop-build-receipt.json')
  let receiptBytes
  try { receiptBytes = await readFile(receiptPath) } catch (error) {
    if (error.code === 'ENOENT') return t.skip('desktop-16 release fixture is not present on this host')
    throw error
  }

  assert.equal(knownPreviousRuntimeIdentity(runtime), knownPreviousRuntime16)
  assert.equal(knownPreviousRuntime16.patchSet, '445dc2c4e9bb3dc745c3bdefba2374d6e8f5db7535fc6ae71f9592e10a8ecba0')
  assert.equal(knownPreviousRuntime16.receiptSha256, createHash('sha256').update(receiptBytes).digest('hex'))
  assert.equal(knownPreviousRuntime16.bundleHash, 'ea6a7e30985d360099d39af9ca9035d718bf46d1681ff0bd7f05f10e0ccf2eca')
  assert.equal(knownPreviousRuntime16.migrationSupported, true)
  assert.equal(knownPreviousRuntime16.requireSourceTargetsMatched, false)

  const harnessHome = path.join(path.dirname(trustedReleaseRoot), 'local-dev/workbench-20261020-02/harness-home')
  const migrationRecord = JSON.parse(await readFile(path.join(harnessHome, 'tradeloom-launcher-desktop.json'), 'utf8'))
  assert.equal(migrationRecord.schema, 1)
  assert.equal(migrationRecord.profile, 'desktop')
  assert.equal(migrationRecord.packageName, '@tradeloom/dsh-business-shell')
  assert.equal(await sameDirectoryIdentity(migrationRecord.runtime, runtime), true)
  assert.equal(migrationRecord.bundleHash, knownPreviousRuntime16.bundleHash)
  assert.equal(await validateKnownPreviousRuntime(runtime), runtime)

  const publishedLockPath = new URL('../../../integrations/dsh/patches/patches.lock.json', import.meta.url)
  const publishedLock = JSON.parse(await readFile(publishedLockPath, 'utf8'))
  assert.equal(Object.keys(publishedLock.patches).length, 20)
  assert.equal(patchSetDigest(publishedLock.patches), knownPreviousRuntime16.patchSet)
  const verified = await verifyDesktopBuildReceipt(runtime, publishedLock)
  assert.equal(verified.patchSetSha256, knownPreviousRuntime16.patchSet)
  assert.deepEqual(verified.compiledFiles, knownPreviousRuntime16.compiledFiles)
})

test('desktop-16 receipt SHA rejects unrelated receipt-field tampering before migration', async t => {
  const actualRuntime = path.join(trustedReleaseRoot, knownPreviousRuntime16.name)
  const receipt = JSON.parse(await readFile(path.join(actualRuntime, '.tradeloom-desktop-build-receipt.json'), 'utf8'))
  receipt.bootstrap.buildEvidence.unrelatedAuditNote = 'tampered'
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-desktop16-receipt-tamper-'))
  const runtime = path.join(releaseRoot, knownPreviousRuntime16.name)
  t.after(async () => {
    const resolved = path.resolve(releaseRoot)
    if (path.dirname(resolved) === path.resolve(os.tmpdir())
      && path.basename(resolved).startsWith('tradeloom-desktop16-receipt-tamper-')) {
      await rm(resolved, { recursive: true, force: true })
    }
  })
  await mkdir(runtime)
  await writeFile(path.join(runtime, '.tradeloom-runtime-owned'), knownPreviousRuntime16.marker)
  await writeFile(path.join(runtime, '.tradeloom-desktop-build-receipt.json'), JSON.stringify(receipt))
  for (const relative of Object.keys(knownPreviousRuntime16.compiledFiles)) {
    const target = path.join(runtime, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, 'compiled fixture')
  }
  const manifestPath = path.join(runtime, 'apps/desktop/package.json')
  await mkdir(path.dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, JSON.stringify({ version: knownPreviousRuntime16.version, dshDesktopAppId: knownPreviousRuntime16.appId }))

  await assert.rejects(validateKnownPreviousRuntime(runtime, {
    releaseRoot,
    readHead: async () => knownPreviousRuntime16.commit,
  }), /receipt SHA-256 不匹配/)
})

