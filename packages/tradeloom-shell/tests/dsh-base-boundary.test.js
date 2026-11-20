import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { checkBoundary } from '../../../scripts/check-dsh-base-boundary.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

test('the DSH base boundary stays declared, patched only through the sanctioned list, and importable', async () => {
  const result = await checkBoundary(repoRoot)
  assert.deepEqual(result.problems, [], `DSH base boundary violations: ${result.problems.join(' | ')}`)
  assert.ok(result.ok)
  assert.equal(result.manifest.base.version, '0.2.1-rc.3', 'the declared base version matches every engine pin')
  assert.ok(result.checks.some(line => line.startsWith('profile bundles 3')),
    'all three profile bundles remain declared in installed-bootstrap.mjs')
  const { manifest, exportTargets } = result.manifest.pluginImportContract.tradeLoomPlugin
  const pkg = JSON.parse(await readFile(join(repoRoot, manifest), 'utf8'))
  assert.deepEqual(pkg.exports, exportTargets, 'the installed shell exposes exactly the accepted profile import targets')
})

async function boundaryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tradeloom-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = JSON.parse(await readFile(join(repoRoot, 'dsh-base.manifest.json'), 'utf8'))
  const pkg = JSON.parse(await readFile(join(repoRoot, manifest.pluginImportContract.tradeLoomPlugin.manifest), 'utf8'))
  const files = new Set(['dsh-base.manifest.json', 'apps/tradeloom-launcher/installed-bootstrap.mjs',
    ...Object.keys(manifest.base.enginePins), ...manifest.base.sanctionedPatches, ...manifest.base.sanctionedDocs,
    ...Object.values(manifest.base.upgrade.recipes ?? {}),
    manifest.pluginImportContract.tradeLoomPlugin.hostEntry, manifest.pluginImportContract.tradeLoomPlugin.clientEntry])
  for (const value of Object.values(pkg.exports)) files.add(join(dirname(manifest.pluginImportContract.tradeLoomPlugin.manifest), typeof value === 'string' ? value : value.default))
  // Include the candidate recipe independently, so a missing declaration is caught.
  for (const name of ['recipe.json', 'production-execution-origin.patch', 'session-list-failure-phase.patch']) files.add(`apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.1/${name}`)
  for (const recipePath of Object.values(manifest.base.upgrade.recipes ?? {})) {
    const recipe = JSON.parse(await readFile(join(repoRoot, recipePath), 'utf8'))
    if (recipe.desktopRecipe) files.add(join(dirname(recipePath), recipe.desktopRecipe))
    if (recipe.programRecipe) {
      const path = join(dirname(recipePath), recipe.programRecipe)
      files.add(path)
      const program = JSON.parse(await readFile(join(repoRoot, path), 'utf8'))
      if (program.launcher.sourceMode === 'exact-source') files.add(program.launcher.source)
    }
    if (recipe.businessShell?.sourceMode === 'exact-source') {
      for (const name of Object.keys(recipe.businessShell.preimages)) files.add(join(recipe.businessShell.sourceRoot, name))
    } else if (recipe.businessShell) {
      files.add(join(dirname(recipePath), recipe.businessShell.packageSource))
    }
  }
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await cp(join(repoRoot, file), join(root, file))
  }
  return root
}

test('versioned upgrade artifacts require explicit manifest registration', async t => {
  const root = await boundaryFixture(t)
  const rogue = 'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.1/unregistered.patch'
  await writeFile(join(root, rogue), 'unregistered patch\n')
  const result = await checkBoundary(root)
  assert.ok(result.problems.some(problem => problem.includes(rogue)), 'the versioned upgrade directory is guarded too')
})

test('registered recipe versions and patch declarations are checked against the supplied repository', async t => {
  const root = await boundaryFixture(t)
  const file = 'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.1/recipe.json'
  const recipe = JSON.parse(await readFile(join(root, file), 'utf8'))
  recipe.version = 'wrong-version'
  await writeFile(join(root, file), JSON.stringify(recipe))
  const result = await checkBoundary(root)
  assert.ok(result.problems.some(problem => problem.includes('recipe version')), 'a candidate recipe must match its registered version')
})

test('rc2 desktop companion version stays explicit while formal engine pins stay rc3', async t => {
  const root = await boundaryFixture(t)
  const path = 'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/desktop-recipe.json'
  const desktop = JSON.parse(await readFile(join(root, path), 'utf8'))
  desktop.version = 'wrong-desktop-version'
  await writeFile(join(root, path), JSON.stringify(desktop))
  const result = await checkBoundary(root)
  assert.ok(result.problems.some(problem => problem.includes('desktop recipe version')))
  assert.equal(result.manifest.base.version, '0.2.1-rc.3')
})

test('rc2 business overlay cannot introduce an unregistered patch', async t => {
  const root = await boundaryFixture(t)
  const path = 'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/recipe.json'
  const recipe = JSON.parse(await readFile(join(root, path), 'utf8'))
  recipe.businessShell.patch = 'unregistered-business.patch'
  await writeFile(join(root, path), JSON.stringify(recipe))
  const result = await checkBoundary(root)
  assert.ok(result.problems.some(problem => problem.includes('business 配方引用未登记')))
})

test('complete-program recipe version and launcher patch stay explicitly registered', async t => {
  const root = await boundaryFixture(t)
  const file = 'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/program-recipe.json'
  const program = JSON.parse(await readFile(join(root, file), 'utf8'))
  program.version = 'wrong-program-version'
  program.launcher.patch = 'unregistered-launcher.patch'
  await writeFile(join(root, file), JSON.stringify(program))
  const result = await checkBoundary(root)
  assert.ok(result.problems.some(problem => problem.includes('program recipe version')))
  assert.ok(result.problems.some(problem => problem.includes('program 配方引用未登记')))
  assert.equal(result.manifest.base.version, '0.2.1-rc.3')
})

test('exact source rejects missing pins, mixed patch inputs and out-of-checkout paths', async t => {
  const root = await boundaryFixture(t)
  const prefix = 'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.3'
  const shellFile = join(root, prefix, 'recipe.json')
  const programFile = join(root, prefix, 'program-recipe.json')
  const recipe = JSON.parse(await readFile(shellFile, 'utf8'))
  const program = JSON.parse(await readFile(programFile, 'utf8'))
  delete recipe.businessShell.preimages['package.json']
  program.launcher.source = '../outside.cs'
  await writeFile(shellFile, JSON.stringify(recipe))
  await writeFile(programFile, JSON.stringify(program))
  let result = await checkBoundary(root)
  assert.ok(result.problems.some(problem => /business exact-source: .*complete package/.test(problem)))
  assert.ok(result.problems.some(problem => /launcher exact-source: .*inside checkout/.test(problem)))
  program.launcher.source = 'apps\\tradeloom-launcher/portable/Program.cs'
  await writeFile(programFile, JSON.stringify(program))
  result = await checkBoundary(root)
  assert.ok(result.problems.some(problem => /launcher exact-source: .*inside checkout/.test(problem)))
  recipe.businessShell.patch = 'not-a-real.patch'
  program.launcher.patch = 'not-a-real.patch'
  await writeFile(shellFile, JSON.stringify(recipe))
  await writeFile(programFile, JSON.stringify(program))
  result = await checkBoundary(root)
  assert.ok(result.problems.some(problem => /mixed business source mode/.test(problem)))
  assert.ok(result.problems.some(problem => /mixed launcher source mode/.test(problem)))
})

test('legacy program recipes still require a registered launcher patch', async t => {
  const root = await boundaryFixture(t)
  const path = join(root, 'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/program-recipe.json')
  const program = JSON.parse(await readFile(path, 'utf8'))
  delete program.launcher.patch
  await writeFile(path, JSON.stringify(program))
  const result = await checkBoundary(root)
  assert.ok(result.problems.some(problem => /launcher/.test(problem)))
})

test('profile import contract rejects an unexpected export and a mismatched scope pin', async t => {
  const root = await boundaryFixture(t)
  const path = join(root, 'packages/tradeloom-shell/package.json')
  const pkg = JSON.parse(await readFile(path, 'utf8'))
  pkg.exports['./webai-files'] = './host.js'
  pkg.peerDependencies['@deepseek-ai/dsh-scope'] = '0.2.2-rc.3'
  await writeFile(path, JSON.stringify(pkg))
  const result = await checkBoundary(root)
  assert.ok(result.problems.some(problem => problem.includes('exports') && problem.includes('./webai-files')))
  assert.ok(result.problems.some(problem => problem.includes('scope') && problem.includes('0.2.2-rc.2')))
})

test('legacy desktop final overlay still requires a registered patch', async t => {
  const root = await boundaryFixture(t)
  const path = join(root, 'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/desktop-recipe.json')
  const recipe = JSON.parse(await readFile(path, 'utf8'))
  recipe.finalOverlay.patch = 'unregistered-final.patch'
  await writeFile(path, JSON.stringify(recipe))
  const result = await checkBoundary(root)
  assert.ok(result.problems.some(problem => problem.includes('desktop') && problem.includes('unregistered-final.patch')))
})

test('profile peer compatibility list rejects versions without registered recipes', async t => {
  const root = await boundaryFixture(t)
  const file = join(root, 'dsh-base.manifest.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  manifest.pluginImportContract.tradeLoomPlugin.peerScopeVersions.push('0.2.2-rc.4')
  await writeFile(file, JSON.stringify(manifest))
  const result = await checkBoundary(root)
  assert.ok(result.problems.includes('invalid registered shell peer scope versions'))
})
