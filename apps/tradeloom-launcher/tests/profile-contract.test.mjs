import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareProfile, profileBundles, trustedReleaseRoot, validateOwnedRuntime } from '../prepare-profile.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const testRuntime = process.env.TRADELOOM_DSH_TEST_RUNTIME ? path.resolve(process.env.TRADELOOM_DSH_TEST_RUNTIME) : undefined
const testReleaseRoot = process.env.TRADELOOM_TEST_RELEASE_ROOT
  ? path.resolve(process.env.TRADELOOM_TEST_RELEASE_ROOT)
  : trustedReleaseRoot
const runtime = testRuntime ?? path.resolve(repoRoot, '../workspace/runtime/tradeloom-harness/releases/0.2.1-rc.3-tradeloom-desktop-12')
const appBootEntry = path.join(runtime, 'packages/boot/app-boot/lib/index.js')
const appBootPackage = path.join(runtime, 'packages/boot/app-boot/package.json')
const sourcePackage = path.join(repoRoot, 'packages/tradeloom-shell')

test('official DSH loader composes base, Web, and TradeLoom bundles from a temporary install anchor', async t => {
  const appBoot = await import(pathToFileURL(appBootEntry).href)
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-profile-contract-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const anchor = path.join(temp, 'install')
  const namespaceDir = path.join(anchor, 'node_modules', '@deepseek-ai')
  await mkdir(namespaceDir, { recursive: true })
  for (const [packageName, source] of [
    ['dsh-base', path.join(runtime, 'packages/bundle/base')],
    ['dsh-web-app', path.join(runtime, 'packages/bundle/web-app')],
  ]) await cp(source, path.join(namespaceDir, packageName), { recursive: true })
  const ownBundleDir = path.join(anchor, 'node_modules', '@tradeloom', 'dsh-business-shell')
  await mkdir(path.dirname(ownBundleDir), { recursive: true })
  await cp(sourcePackage, ownBundleDir, { recursive: true })
  await writeFile(path.join(anchor, 'package.json'), JSON.stringify({ name: 'tradeloom-test-anchor', private: true }) + '\n')
  const home = path.join(temp, 'home')
  const profileDir = path.join(home, 'profiles', 'tradeloom')
  appBoot.initProfile(profileDir, profileBundles)

  const profile = appBoot.loadProfile('app', 'tradeloom', path.join(anchor, 'package.json'), home)
  assert.deepEqual(profile.layers.map(layer => layer.packageName), profileBundles, JSON.stringify(profile.skippedBundles))
  assert.deepEqual(profile.skippedBundles, [])
  const warnings = []
  const entries = appBoot.composeEntries(profile.layers.map(layer => layer.patches), warning => warnings.push(warning))
  assert.deepEqual(warnings, [])
  assert.ok(entries.some(entry => entry.id === 'tradeloom-business-shell-host' && entry.name === '@tradeloom/dsh-business-shell'))
  assert.equal(entries.find(entry => entry.id === 'agent-preset-registry')?.config?.default, 'tradeloom-center')
  for (const preset of ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis']) {
    assert.equal(entries.find(entry => entry.id === preset)?.disabled, true)
  }
  const manifest = JSON.parse(await readFile(path.join(ownBundleDir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-client-ui-model-selection',
  ])
  for (const relative of manifest.files) await readFile(path.join(ownBundleDir, relative))
  const desktopDir = path.join(home, 'profiles', 'desktop')
  appBoot.initProfile(desktopDir, profileBundles)
  const desktopProfile = appBoot.loadProfile('app', 'desktop', path.join(anchor, 'package.json'), home)
  assert.deepEqual(desktopProfile.layers.map(layer => layer.packageName), profileBundles, JSON.stringify(desktopProfile.skippedBundles))
  assert.deepEqual(desktopProfile.skippedBundles, [])
  assert.equal(JSON.parse(await readFile(appBootPackage, 'utf8')).name, '@deepseek-ai/dsh-app-boot')
})

test('prepared profile resolves its installed pinned TradeLoom bundle through official DSH and Node resolution', async t => {
  const runtime = testRuntime ?? path.join(testReleaseRoot, '0.2.1-rc.3-tradeloom-desktop-12')
  const appBootEntry = path.join(runtime, 'packages/boot/app-boot/lib/index.js')
  const appBoot = await import(pathToFileURL(appBootEntry).href)
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-prepared-profile-'))
  t.after(() => rm(temp, { recursive: true, force: true }))

  const prepared = await prepareProfile({
    runtimePath: runtime,
    home: path.join(temp, 'home'),
    agentsHome: path.join(temp, 'agents'),
    workspace: path.join(temp, 'workspace'),
    mode: 'web',
    validateRuntimeFn: runtimePath => validateOwnedRuntime(runtimePath, testReleaseRoot),
    source: path.join(runtime, 'node_modules', '@tradeloom', 'dsh-business-shell'),
  })
  const profileBundle = path.join(prepared.profileDir, 'node_modules', '@tradeloom', 'dsh-business-shell')
  assert.equal(JSON.parse(await readFile(path.join(profileBundle, 'package.json'), 'utf8')).name, '@tradeloom/dsh-business-shell')

  const probe = path.join(prepared.profileDir, 'resolution-probe.mjs')
  await writeFile(probe, "import { BUSINESS_PRESETS } from '@tradeloom/dsh-business-shell/policy'; export { BUSINESS_PRESETS }\n")
  const loadedProbe = await import(`${pathToFileURL(probe).href}?test=${Date.now()}`)
  assert.ok(loadedProbe.BUSINESS_PRESETS.has('tradeloom-center'))

  const anchor = path.join(temp, 'install-anchor')
  const namespaceDir = path.join(anchor, 'node_modules', '@deepseek-ai')
  await mkdir(namespaceDir, { recursive: true })
  for (const [name, source] of [
    ['dsh-base', path.join(runtime, 'packages/bundle/base')],
    ['dsh-web-app', path.join(runtime, 'packages/bundle/web-app')],
  ]) await cp(source, path.join(namespaceDir, name), { recursive: true })
  const anchorManifest = path.join(anchor, 'package.json')
  await writeFile(anchorManifest, JSON.stringify({ name: 'tradeloom-test-anchor', private: true }) + '\n')

  const profile = appBoot.loadProfile('app', 'tradeloom', anchorManifest, prepared.home)
  assert.deepEqual(profile.layers.map(layer => layer.packageName), profileBundles, JSON.stringify(profile.skippedBundles))
  assert.deepEqual(profile.skippedBundles, [])
  assert.equal(path.resolve(profile.layers.at(-1).packageDir), path.resolve(profileBundle))
})
