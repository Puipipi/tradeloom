import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const workspaceRoot = process.env.TRADELOOM_TEST_WORKSPACE_ROOT
  ? path.resolve(process.env.TRADELOOM_TEST_WORKSPACE_ROOT)
  : path.resolve(repoRoot, '../workspace')
const upstream = path.join(workspaceRoot, 'research/references/deepseek-harness-v0.2.1-rc.3-readonly')
const patchFile = path.join(repoRoot, 'integrations/dsh/patches/desktop-identity.patch')
const targets = [
  'apps/desktop/scripts/electron-builder-config.mjs',
  'apps/desktop/src/main.ts',
  'apps/desktop/installer/uninstall.nsh',
  'apps/desktop-host/src/index.ts',
  'apps/desktop/src/web-document.ts',
  'apps/desktop/tests/web-document.spec.ts',
  'apps/desktop/src/update-coordinator.ts',
  'apps/desktop/tests/main-startup.spec.ts',
  'apps/desktop/scripts/smoke-packaged-runtime.ts',
  'apps/desktop/scripts/desktop-build-paths.d.mts',
  'apps/desktop/scripts/desktop-build-paths.mjs',
  'apps/desktop/scripts/desktop-package-environment.d.mts',
  'apps/desktop/scripts/desktop-package-environment.mjs',
  'apps/desktop/scripts/package-target.ts',
  'apps/desktop/tests/desktop-build-paths.spec.ts',
  'apps/desktop/tests/desktop-package-environment.spec.ts',
]

test('desktop identity patch applies to pinned builder and main source in an isolated fixture', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-desktop-identity-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  for (const relative of targets) {
    const destination = path.join(temp, relative)
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(path.join(upstream, relative), destination)
  }
  const normalizePatch = async (source, name) => {
    const normalized = path.join(temp, name)
    await writeFile(normalized, (await readFile(source, 'utf8')).replaceAll('\r\n', '\n'))
    return normalized
  }
  const identityPatch = await normalizePatch(patchFile, 'desktop-identity.patch')
  execFileSync('git', ['-C', temp, 'apply', '--check', identityPatch], { stdio: 'pipe' })
  execFileSync('git', ['-C', temp, 'apply', identityPatch], { stdio: 'pipe' })
  const hostPatch = path.join(repoRoot, 'integrations/dsh/patches/desktop-host-lan.patch')
  const normalizedHostPatch = await normalizePatch(hostPatch, 'desktop-host-lan.patch')
  execFileSync('git', ['-C', temp, 'apply', '--check', normalizedHostPatch], { stdio: 'pipe' })
  execFileSync('git', ['-C', temp, 'apply', normalizedHostPatch], { stdio: 'pipe' })
  const csrfPatch = path.join(repoRoot, 'integrations/dsh/patches/desktop-business-csrf.patch')
  const normalizedCsrfPatch = await normalizePatch(csrfPatch, 'desktop-business-csrf.patch')
  execFileSync('git', ['-C', temp, 'apply', '--check', normalizedCsrfPatch], { stdio: 'pipe' })
  execFileSync('git', ['-C', temp, 'apply', normalizedCsrfPatch], { stdio: 'pipe' })
  const updatePatch = path.join(repoRoot, 'integrations/dsh/patches/desktop-managed-update.patch')
  const normalizedUpdatePatch = await normalizePatch(updatePatch, 'desktop-managed-update.patch')
  execFileSync('git', ['-C', temp, 'apply', '--check', normalizedUpdatePatch], { stdio: 'pipe' })
  execFileSync('git', ['-C', temp, 'apply', normalizedUpdatePatch], { stdio: 'pipe' })
  const builder = await readFile(path.join(temp, targets[0]), 'utf8')
  const main = await readFile(path.join(temp, targets[1]), 'utf8')
  const uninstaller = await readFile(path.join(temp, targets[2]), 'utf8')
  const desktopHost = await readFile(path.join(temp, targets[3]), 'utf8')
  const webDocument = await readFile(path.join(temp, targets[4]), 'utf8')
  assert.match(builder, /appId: 'cn\.tradeloom\.workbench'/)
  assert.match(builder, /name: 'tradeloom'/)
  assert.match(builder, /main: 'lib\/tradeloom\/bootstrap-entry\.mjs'/)
  assert.match(builder, /from: join\(desktopStage, 'launcher'\), to: 'lib\/tradeloom', filter: \['\*\.mjs'\]/)
  assert.match(builder, /from: join\(desktopStage, 'resources', 'tradeloom'\), to: 'tradeloom'/)
  assert.match(builder, /schemes: \['tradeloom'\]/)
  assert.match(builder, /productName: '织贸助手'/)
  assert.match(main, /app\.setName\('织贸助手'\)/)
  assert.match(main, /app\.setPath\('userData', join\(tradeLoomData, 'user-data'\)\)/)
  assert.match(main, /app\.setPath\('cache', join\(tradeLoomData, 'cache'\)\)/)
  assert.match(main, /setAsDefaultProtocolClient\('tradeloom'\)/)
  assert.doesNotMatch(main, /setAsDefaultProtocolClient\('dsh'\)/)
  assert.match(uninstaller, /ReadEnvStr \$UnHome DSH_HOME/)
  assert.match(uninstaller, /\$APPDATA\\\$\{PRODUCT_FILENAME\}/)
  assert.match(uninstaller, /\$APPDATA\\\$\{APP_PACKAGE_NAME\}/)
  assert.match(uninstaller, /\$LOCALAPPDATA\\\$\{DSH_UPDATER_CACHE_NAME\}/)
  assert.match(desktopHost, /TRADELOOM_DSH_BIND_HOST \?\? '127\.0\.0\.1'/)
  assert.match(desktopHost, /TRADELOOM_DSH_BIND_PORT \?\? '0'/)
  assert.match(desktopHost, /ctx\.webServer\.host/)
  assert.doesNotMatch(desktopHost, /authenticatedUrl\(`\$\{ctx\.webServer\.protocol\}\/\/127\.0\.0\.1/)
  assert.match(webDocument, /BUSINESS_CSRF_COOKIE\.set\(target\.origin/)
  assert.match(webDocument, /headers\.set\('cookie', \[cookie, csrfCookie\]/)
  assert.match(webDocument, /headers\.set\('origin', target\.origin\)/)
  assert.match(webDocument, /rendererCsrfCookie !== undefined/)
  const updateCoordinator = await readFile(path.join(temp, 'apps/desktop/src/update-coordinator.ts'), 'utf8')
  assert.match(updateCoordinator, /enabled: \(\) => boolean = \(\) => app\.getName\(\) !== '织贸助手'/)
  assert.match(main, /const openUpdatePrompt = \(manual = false\): Promise<void> => \{\s+if \(app\.getName\(\) === '织贸助手'\) return Promise\.resolve\(\)/)
})

test('actual electron-builder config returns independent TradeLoom metadata', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-builder-config-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  for (const relative of targets) {
    const destination = path.join(temp, relative)
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(path.join(upstream, relative), destination)
  }
  const stage = path.join(temp, 'owned-stage')
  await mkdir(path.join(stage, 'launcher'), { recursive: true })
  await mkdir(path.join(stage, 'resources'), { recursive: true })
  await writeFile(path.join(stage, '.tradeloom-desktop-stage-owned'), 'tradeloom-desktop-stage-v1\n')
  await cp(path.join(upstream, 'apps/desktop/package.json'), path.join(temp, 'apps/desktop/package.json'))
  const normalizedIdentityPatch = path.join(temp, 'desktop-identity.patch')
  await writeFile(normalizedIdentityPatch, (await readFile(patchFile, 'utf8')).replaceAll('\r\n', '\n'))
  execFileSync('git', ['-C', temp, 'apply', normalizedIdentityPatch], { stdio: 'pipe' })
  const updatePatch = path.join(repoRoot, 'integrations/dsh/patches/desktop-managed-update.patch')
  const normalizedUpdatePatch = path.join(temp, 'desktop-managed-update.patch')
  await writeFile(normalizedUpdatePatch, (await readFile(updatePatch, 'utf8')).replaceAll('\r\n', '\n'))
  execFileSync('git', ['-C', temp, 'apply', normalizedUpdatePatch], { stdio: 'pipe' })
  const configPath = path.join(temp, 'apps/desktop/scripts/electron-builder-config.mjs')
  const configSource = (await readFile(configPath, 'utf8')).replaceAll('\r\n', '\n')
  const functionSource = configSource.slice(configSource.indexOf('/**\n * Create electron-builder configuration'))
const isolatedImports = `import { readFileSync } from 'node:fs';\nimport { isAbsolute, join } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { promisify } from 'node:util';\nimport { execFile } from 'node:child_process';\nimport os from 'node:os';\nconst resolveDesktopAppId = () => 'org.upstream.app';\nconst isTradeLoomBuildIntent = () => false;\nconst resolveDesktopPolicyEnvironment = () => undefined;\nconst resolveMacOSNotarizationEnvironment = () => undefined;\nconst resolveMacOSSigningEnvironment = () => undefined;\nconst createWindowsTokenSigner = () => undefined;\nconst installWindowsNsisBootstrapSigner = () => undefined;\nconst resolveWindowsUpdatePublisher = () => undefined;\nconst scrubWindowsSigningEnvironment = value => value;\nconst resolveDesktopAutoUpdateConfig = () => undefined;\nconst resolveDesktopBuildCommit = () => undefined;\nconst resolveDesktopBuildVersion = (_env, version) => version;\nconst desktopTargetBuildPaths = () => ({ runtime: 'runtime', dsh: 'dsh', root: 'root', electron: 'electron' });\nconst resolveDesktopBuildTarget = () => ({});\nconst desktopArtifactOutput = () => ({ directory: 'output', suffix: '' });\nconst recordPackagingEvent = () => undefined;\nconst prepareWindowsAsarUnpack = () => undefined;\nconst verifyWindowsAsarUnpack = () => undefined;\nconst preserveWindowsRuntimeSignature = () => undefined;\nconst signWindowsCode = () => undefined;\nconst notarizeMacOSDiskImageArtifact = () => undefined;\nconst verifyMacOSDiskImageSignature = () => undefined;\nconst verifyMacOSSignatureAfterSign = () => undefined;\nconst resolveMacOSAppUpdateFeed = () => undefined;\nconst verifyMacOSAppUpdateConfig = () => undefined;\nconst writeMacOSAppUpdateConfig = () => undefined;\nconst officePackageDirectories = [];\n`
  await writeFile(configPath, isolatedImports + functionSource)
  const configUrl = pathToFileURL(configPath).href
  const { createElectronBuilderConfig } = await import(configUrl)
  const config = createElectronBuilderConfig({ DSH_DESKTOP_UNSIGNED: '1', TRADELOOM_DESKTOP_STAGE: stage }, 'linux', 'x64')
  assert.throws(() => createElectronBuilderConfig({ DSH_DESKTOP_UNSIGNED: '1' }, 'linux', 'x64'), /explicit absolute TRADELOOM_DESKTOP_STAGE/)
  assert.match(configSource, /const update = unsigned \|\| isTradeLoomBuildIntent\(env\) \? undefined : resolveDesktopAutoUpdateConfig\(env, resolvedPlatform, resolvedArch\)/)
  assert.equal(config.appId, 'cn.tradeloom.workbench')
  assert.equal(config.productName, '织贸助手')
  assert.equal(config.extraMetadata.name, 'tradeloom')
  assert.equal(config.extraMetadata.main, 'lib/tradeloom/bootstrap-entry.mjs')
  assert.match(config.artifactName, /^tradeloom-/)
  assert.ok(config.files.some(item => typeof item === 'object' && item.from === path.join(stage, 'launcher') && item.to === 'lib/tradeloom' && item.filter.includes('*.mjs')))
  assert.ok(config.extraResources.some(item => item.from === path.join(stage, 'resources', 'tradeloom') && item.to === 'tradeloom'))
  assert.deepEqual(config.protocols, [{ name: '织贸助手', schemes: ['tradeloom'] }])
  assert.equal(config.extraMetadata.dshDesktopUpdateChannel, 'nightly')
})
