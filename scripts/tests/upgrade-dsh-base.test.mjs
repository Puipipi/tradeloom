import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../upgrade-dsh-base.mjs', import.meta.url))

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tradeloom-upgrade-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'), { recursive: true })
  await cp(script, join(root, 'scripts/upgrade-dsh-base.mjs'))
  const overrides = join(root, 'apps/tradeloom-launcher/accepted-sdk-overrides')
  await mkdir(overrides, { recursive: true })
  for (const [patch, name] of [['production-execution-origin', 'a.js'], ['session-list-failure-phase', 'b.js']]) {
    await writeFile(join(overrides, `${patch}.patch`),
      `diff --git a/dsh/${name} b/dsh/${name}\n--- a/dsh/${name}\n+++ b/dsh/${name}\n@@ -1 +1 @@\n-export const value = 'old'\n+export const value = 'new'\n`)
  }
  const pins = {
    'apps/tradeloom-launcher/accepted-runtime/renderer/source-shell/renderers.js': "var ADAPTED_ENGINE = 'old'\n",
    'apps/tradeloom-launcher/accepted-runtime/lib/main.js': 'function desktopClientVersion() { return "old" }\n',
    'packages/tradeloom-shell/package.json': '{"peerDependencies":{"@deepseek-ai/dsh-scope":"old"}}\n',
    'dsh-base.manifest.json': '{"base":{"version":"old"}}\n',
  }
  for (const [name, text] of Object.entries(pins)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), text)
  }
  const source = join(root, 'source')
  await mkdir(join(source, 'dsh'), { recursive: true })
  for (const name of ['a.js', 'b.js']) await writeFile(join(source, 'dsh', name), "export const value = 'old'\n")
  await writeFile(join(source, 'dsh', 'unchanged.txt'), 'must survive staging\n')
  // Every requested version needs its own explicit recipe, including fixtures.
  const directory = join(root, 'apps/tradeloom-launcher/dsh-upgrades/new')
  await mkdir(directory, { recursive: true })
  const patches = ['production-execution-origin.patch', 'session-list-failure-phase.patch']
  for (const name of patches) await cp(join(overrides, name), join(directory, name))
  const pin = text => ({ bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') })
  await writeFile(join(directory, 'recipe.json'), JSON.stringify({
    schemaVersion: 1, version: 'new', patches,
    preimages: Object.fromEntries(['a.js', 'b.js'].map(name => [`dsh/${name}`, pin("export const value = 'old'\n")])),
    postimages: Object.fromEntries(['a.js', 'b.js'].map(name => [`dsh/${name}`, pin("export const value = 'new'\n")])),
  }))
  return { root, source, pins }
}

async function invoke(root, source, ...args) {
  const { stdout } = await run(process.execPath,
    [join(root, 'scripts/upgrade-dsh-base.mjs'), '--source', source, '--version', 'new', ...args],
    { cwd: root })
  return JSON.parse(stdout)
}

test('ASAR dry-run reads payload after the padded header, without changing source pins', async t => {
  const { root, pins } = await fixture(t)
  const payload = Buffer.from("export const value = 'old'\n")
  let header
  for (let length = 0; length < 4; length++) {
    header = Buffer.from(JSON.stringify({ files: { dsh: { files: {
      'a.js': { size: payload.length, offset: '0' },
      'b.js': { size: payload.length, offset: String(payload.length) },
    } } }, fixturePadding: 'x'.repeat(length) }))
    if (header.length % 4 !== 0) break
  }
  const padding = (4 - header.length % 4) % 4
  assert.ok(padding > 0)
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(8 + header.length + padding, 4)
  prefix.writeUInt32LE(4 + header.length + padding, 8)
  prefix.writeUInt32LE(header.length, 12)
  const archive = join(root, 'source.asar')
  await writeFile(archive, Buffer.concat([prefix, header, Buffer.alloc(padding), payload, payload]))
  const report = await invoke(root, archive, '--dry-run')
  assert.equal(report.status, 'dry-run-clean')
  assert.ok(report.patches.every(item => item.ok))
  for (const [name, text] of Object.entries(pins)) assert.equal(await readFile(join(root, name), 'utf8'), text)
})

test('stage contains the complete base with both patches applied, without editing repository pins', async t => {
  const { root, source, pins } = await fixture(t)
  const stage = join(root, 'stage')
  const report = await invoke(root, source, '--stage', stage)
  assert.equal(report.status, 'stage-ready')
  for (const name of ['a.js', 'b.js']) {
    assert.equal(await readFile(join(stage, 'dsh', name), 'utf8'), "export const value = 'new'\n")
    assert.equal(await readFile(join(source, 'dsh', name), 'utf8'), "export const value = 'old'\n")
  }
  assert.equal(await readFile(join(stage, 'dsh/unchanged.txt'), 'utf8'), 'must survive staging\n')
  for (const [name, text] of Object.entries(pins)) assert.equal(await readFile(join(root, name), 'utf8'), text)
})

test('stage refuses an existing destination and leaves its bytes unchanged', async t => {
  const { root, source } = await fixture(t)
  const stage = join(root, 'stage')
  await mkdir(stage)
  await writeFile(join(stage, 'keep.txt'), 'existing bytes')
  await assert.rejects(invoke(root, source, '--stage', stage), /destination_exists/)
  assert.equal(await readFile(join(stage, 'keep.txt'), 'utf8'), 'existing bytes')
})

test('a rejected patch does not publish a stage or update accepted pins', async t => {
  const { root, source, pins } = await fixture(t)
  const changed = "export const value = 'different upstream'\n"
  await writeFile(join(source, 'dsh/b.js'), changed)
  // The source is a recognized full preimage; its patch still must apply.
  const recipePath = join(root, 'apps/tradeloom-launcher/dsh-upgrades/new/recipe.json')
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'))
  recipe.preimages['dsh/b.js'] = { bytes: Buffer.byteLength(changed), sha256: createHash('sha256').update(changed).digest('hex') }
  await writeFile(recipePath, JSON.stringify(recipe))
  const stage = join(root, 'stage')
  await assert.rejects(invoke(root, source, '--stage', stage), error => {
    const report = JSON.parse(error.stdout)
    assert.equal(report.status, 'blocked-unresolved-hunks')
    assert.equal(report.patches.find(item => item.patch === 'session-list-failure-phase.patch').ok, false)
    return true
  })
  await assert.rejects(readFile(join(stage, 'dsh/a.js')), { code: 'ENOENT' })
  for (const [name, text] of Object.entries(pins)) assert.equal(await readFile(join(root, name), 'utf8'), text)
})

async function versionedFixture(t) {
  const f = await fixture(t)
  const directory = join(f.root, 'apps/tradeloom-launcher/dsh-upgrades/new')
  await mkdir(directory, { recursive: true })
  const patchNames = ['production-execution-origin.patch', 'session-list-failure-phase.patch']
  for (const name of patchNames) await cp(join(f.root, 'apps/tradeloom-launcher/accepted-sdk-overrides', name), join(directory, name))
  const before = "export const value = 'old'\n"
  const after = "export const value = 'new'\n"
  const front = 'const transport = {};\n'
  const nextFront = 'const transport = {}; transport.installed = true;\n'
  const adapter = 'export const adapter = true;\n'
  const pin = text => ({ bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') })
  await writeFile(join(f.source, 'dsh/frontend.js'), front)
  await writeFile(join(f.root, 'adapter.mjs'), adapter)
  const recipe = {
    schemaVersion: 1, version: 'new', patches: patchNames,
    preimages: { 'dsh/a.js': pin(before), 'dsh/b.js': pin(before), 'dsh/frontend.js': pin(front) },
    postimages: { 'dsh/a.js': pin(after), 'dsh/b.js': pin(after), 'dsh/frontend.js': pin(nextFront), 'dsh/adapter.mjs': pin(adapter) },
    browserBootstrap: { entry: 'dsh/frontend.js', needle: front.trimEnd(), replacement: nextFront.trimEnd() },
    copies: [{ source: 'adapter.mjs', destination: 'dsh/adapter.mjs', sha256: pin(adapter).sha256 }],
  }
  await writeFile(join(directory, 'recipe.json'), JSON.stringify(recipe))
  return { ...f, nextFront, adapter }
}

test('the exact version recipe installs its frontend hook and canonical adapter with postimage readback', async t => {
  const { root, source, nextFront, adapter } = await versionedFixture(t)
  const stage = join(root, 'stage')
  const report = await invoke(root, source, '--stage', stage)
  assert.equal(report.recipeVersion, 'new')
  assert.equal(await readFile(join(stage, 'dsh/frontend.js'), 'utf8'), nextFront)
  assert.equal(await readFile(join(stage, 'dsh/adapter.mjs'), 'utf8'), adapter)
  assert.equal(report.postimagesVerified, 4)
})

test('a versioned recipe rejects upstream bytes that drift outside its checked patch context', async t => {
  const { root, source } = await versionedFixture(t)
  await writeFile(join(source, 'dsh/frontend.js'), 'const changedUpstream = {};\n')
  await assert.rejects(invoke(root, source, '--stage', join(root, 'stage')), /preimage_mismatch/)
})

test('an unknown or mismatched version never falls back to accepted patches', async t => {
  const { root, source } = await fixture(t)
  const recipePath = join(root, 'apps/tradeloom-launcher/dsh-upgrades/new/recipe.json')
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'))
  recipe.version = 'another-version'
  await writeFile(recipePath, JSON.stringify(recipe))
  await assert.rejects(invoke(root, source, '--dry-run'), /recipe_version_mismatch/)
  await rm(recipePath)
  await assert.rejects(invoke(root, source, '--dry-run'), /missing_version_recipe/)
})

test('dry-run verifies postimages and canonical copy bytes without publishing', async t => {
  const { root, source } = await versionedFixture(t)
  const report = await invoke(root, source, '--dry-run')
  assert.equal(report.postimagesVerified, 4)
  assert.equal(await readFile(join(source, 'dsh/frontend.js'), 'utf8'), 'const transport = {};\n')
  await writeFile(join(root, 'adapter.mjs'), 'stale adapter\n')
  const stage = join(root, 'stage')
  await assert.rejects(invoke(root, source, '--stage', stage), /canonical_copy_mismatch/)
  await assert.rejects(readFile(join(stage, 'dsh/a.js')), { code: 'ENOENT' })
})

test('an incorrect postimage cannot be published even when all patch contexts match', async t => {
  const { root, source } = await versionedFixture(t)
  const recipePath = join(root, 'apps/tradeloom-launcher/dsh-upgrades/new/recipe.json')
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'))
  recipe.postimages['dsh/frontend.js'].sha256 = '0'.repeat(64)
  await writeFile(recipePath, JSON.stringify(recipe))
  const stage = join(root, 'stage')
  await assert.rejects(invoke(root, source, '--stage', stage), /postimage_mismatch/)
  await assert.rejects(readFile(join(stage, 'dsh/a.js')), { code: 'ENOENT' })
})

test('browser bootstrap requires exactly one anchor in the fully verified preimage', async t => {
  const { root, source } = await versionedFixture(t)
  const front = 'const transport = {};\nconst transport = {};\n'
  await writeFile(join(source, 'dsh/frontend.js'), front)
  const recipePath = join(root, 'apps/tradeloom-launcher/dsh-upgrades/new/recipe.json')
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'))
  recipe.preimages['dsh/frontend.js'] = { bytes: Buffer.byteLength(front), sha256: createHash('sha256').update(front).digest('hex') }
  await writeFile(recipePath, JSON.stringify(recipe))
  await assert.rejects(invoke(root, source, '--dry-run'), /browser_bootstrap_anchor_count/)
})

test('a bootstrap file on disk is insufficient when index.html loads a different entry', async t => {
  const { root, source } = await versionedFixture(t)
  await writeFile(join(source, 'dsh/index.html'), '<script type="module" src="./another-frontend.js"></script>\n')
  const recipePath = join(root, 'apps/tradeloom-launcher/dsh-upgrades/new/recipe.json')
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'))
  recipe.browserBootstrap.html = 'dsh/index.html'
  await writeFile(recipePath, JSON.stringify(recipe))
  await assert.rejects(invoke(root, source, '--dry-run'), /browser_bootstrap_entry_not_loaded/)
  await writeFile(join(source, 'dsh/index.html'), '<script type="module" src="./frontend.js"></script>\n')
  assert.equal((await invoke(root, source, '--dry-run')).postimagesVerified, 4)
})

test('truncation repair cannot change a file outside the recipe image pins', async t => {
  const { root, source } = await fixture(t)
  const path = join(source, 'dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, '>\nexport const upstream = true;\n')
  await assert.rejects(invoke(root, source, '--dry-run'), /untracked_truncation_repair/)
})


const rc3ReplayRoot = process.env.TL_RC3_REPLAY_ROOT
test('rc.3 generated Host bridge resolves its actual SDK and rejects unsupported peers', {
  skip: !rc3ReplayRoot && 'requires actual rc.3 strict replay output',
}, async () => {
  const source = await readFile(join(rc3ReplayRoot, 'desktop/lib/main.js'), 'utf8')
  const start = source.indexOf('function resolveDesktopHostBridge(runtimeDir) {')
  const end = source.indexOf('\nfunction isDesktopHostEvent(', start)
  assert.ok(start >= 0 && end > start)

  const runtimeDirectory = join(rc3ReplayRoot, 'sdk/dsh')
  const actualRequire = createRequire(pathToFileURL(join(runtimeDirectory, 'package.json')))
  const managerPackage = '@deepseek-ai/dsh-plugin-manager/package.json'
  const managerDiagnostic = '@deepseek-ai/dsh-plugin-manager/diagnostic'
  const diagnostic = actualRequire(managerDiagnostic)
  assert.equal(actualRequire('./package.json').version, '0.2.2-rc.3')
  assert.equal(actualRequire(managerPackage).version, '0.2.2-rc.3')
  assert.equal(typeof diagnostic.parsePluginOperationRecord, 'function')

  const resolveWith = requireFactory => runInNewContext(
    source.slice(start, end) + '\nresolveDesktopHostBridge',
    { createRequire: requireFactory, pathToFileURL, join },
  )(runtimeDirectory)
  const bridge = resolveWith(createRequire)
  assert.equal(bridge.parseRecord, diagnostic.parsePluginOperationRecord)
  assert.equal(bridge.isRunId('097bf652-27a6-4b98-a720-da9ce8b641b4'), true)
  assert.equal(bridge.isRunId('not-a-uuid'), false)

  const controlled = (version, managerVersion = version, parser = diagnostic) => resolveWith(() => name => {
    if (name === './package.json') return { version }
    if (name === managerPackage) return { version: managerVersion }
    if (name === managerDiagnostic) return parser
    return actualRequire(name)
  })
  for (const version of ['0.2.2-rc.1', '0.2.2-rc.2']) {
    assert.equal(controlled(version).parseRecord, diagnostic.parsePluginOperationRecord)
  }
  assert.equal(controlled('0.2.1-rc.3').parseRecord, undefined)
  assert.throws(() => controlled('0.2.2-rc.4'), /runtime version is not covered/)
  assert.throws(() => controlled('0.2.2-rc.3', '0.2.2-rc.2'), /manager version does not match/)
  assert.throws(() => controlled('0.2.2-rc.3', '0.2.2-rc.3', {}), /public operation diagnostic parser is unavailable/)
})

test('rc.3 backend manifest stages a standalone native artifact validator', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tradeloom-artifact-validator-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = new URL('../../', import.meta.url)
  const { backendSources } = JSON.parse(await readFile(new URL(
    'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.3/program-recipe.json', repo), 'utf8'))
  const validator = 'workbench/native_artifact_validator.mjs'
  for (const relative of backendSources.filter(path => path === validator || path.startsWith('packages/tradeloom-shell/'))) {
    await mkdir(join(root, relative, '..'), { recursive: true })
    await cp(new URL(relative, repo), join(root, relative))
  }

  const env = Object.fromEntries(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  const child = run(process.execPath, [join(root, validator)], { cwd: root, env })
  child.child.stdin.end('{}')
  const { stdout, stderr } = await child
  assert.deepEqual(JSON.parse(stdout), { ok: false, code: 'source_unverified' })
  assert.equal(stderr, '')
})
