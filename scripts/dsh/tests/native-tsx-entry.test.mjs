import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const wrapperUrl = new URL('../build-candidate.mjs', import.meta.url)
const fixturePrefix = 'dsh-native-tsx-entry-'
const pnpmFixturePrefix = 'dsh-native-pnpm-entry-'

async function removeCandidateFixture(root, prefix = fixturePrefix) {
  const tempRoot = await realpath(os.tmpdir())
  const candidateRoot = await realpath(path.resolve(root))
  const relative = path.relative(tempRoot, candidateRoot)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || path.dirname(candidateRoot) !== tempRoot
    || !path.basename(candidateRoot).startsWith(prefix)
    || path.basename(candidateRoot).length === prefix.length) {
    throw new Error('refusing to remove a fixture outside its mkdtemp directory.')
  }
  await rm(candidateRoot, { recursive: true, force: true })
}

async function createCandidateFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), fixturePrefix))
  t.after(() => removeCandidateFixture(root))
  const storePackage = path.join(root, 'node_modules', '.pnpm', 'tsx@4.23.13', 'node_modules', 'tsx')
  await mkdir(path.join(storePackage, 'dist'), { recursive: true })
  await writeFile(path.join(storePackage, 'package.json'), JSON.stringify({
    name: 'tsx',
    version: '4.23.13',
    bin: { tsx: './dist/cli.mjs' },
  }))
  await writeFile(path.join(storePackage, 'dist', 'cli.mjs'), [
    'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))',
    'if (process.argv.includes("--exit=23")) process.exit(23)',
  ].join('\n'))
  await symlink(storePackage, path.join(root, 'node_modules', 'tsx'), process.platform === 'win32' ? 'junction' : 'dir')
  return { root, storePackage, cliPath: path.join(storePackage, 'dist', 'cli.mjs') }
}

async function createPnpmFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), pnpmFixturePrefix))
  t.after(() => removeCandidateFixture(root, pnpmFixturePrefix))
  const storePackage = path.join(root, 'node_modules', '.pnpm', 'pnpm@11.28.5', 'node_modules', 'pnpm')
  await mkdir(path.join(storePackage, 'bin'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.28.5' }))
  await writeFile(path.join(storePackage, 'package.json'), JSON.stringify({
    name: 'pnpm',
    version: '11.28.5',
    bin: { pnpm: './bin/pnpm.mjs' },
  }))
  await writeFile(path.join(storePackage, 'bin', 'pnpm.mjs'), [
    'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))',
    'if (process.argv.includes("--exit=31")) process.exit(31)',
  ].join('\n'))
  await symlink(storePackage, path.join(root, 'node_modules', 'pnpm'), process.platform === 'win32' ? 'junction' : 'dir')
  return { root, storePackage, cliPath: path.join(storePackage, 'bin', 'pnpm.mjs') }
}

test('launches the candidate-owned TSX CLI directly with Node and preserves argv/status', async t => {
  const { resolveRuntimeTsxCli, runtimeTsxInvocation } = await import(wrapperUrl.href)
  const fixture = await createCandidateFixture(t)

  const cliPath = await resolveRuntimeTsxCli(fixture.root)
  assert.equal(cliPath, await realpath(fixture.cliPath))
  const argv = ['prepare-development-project.mjs', '--value', 'space preserved', '--exit=23']
  const invocation = await runtimeTsxInvocation(fixture.root, argv)

  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.args, [cliPath, ...argv])
  const result = spawnSync(invocation.command, invocation.args, { cwd: fixture.root, encoding: 'utf8' })
  assert.equal(result.status, 23)
  assert.deepEqual(JSON.parse(result.stdout), { args: argv, cwd: fixture.root })
})

test('rejects TSX package metadata that disagrees with its pnpm store directory', async t => {
  const { resolveRuntimeTsxCli } = await import(wrapperUrl.href)
  const fixture = await createCandidateFixture(t)
  const manifestPath = path.join(fixture.storePackage, 'package.json')
  await writeFile(manifestPath, JSON.stringify({ name: 'tsx', version: '9.9.9', bin: { tsx: './dist/cli.mjs' } }))

  await assert.rejects(resolveRuntimeTsxCli(fixture.root), /does not match its pnpm store entry/)
})

test('rejects when the runtime TSX dependency link points outside the selected pnpm package', async t => {
  const { resolveRuntimeTsxCli } = await import(wrapperUrl.href)
  const fixture = await createCandidateFixture(t)
  const wrongPackage = path.join(fixture.root, 'external-tsx')
  await mkdir(wrongPackage)
  await unlink(path.join(fixture.root, 'node_modules', 'tsx'))
  await symlink(wrongPackage, path.join(fixture.root, 'node_modules', 'tsx'), process.platform === 'win32' ? 'junction' : 'dir')

  await assert.rejects(resolveRuntimeTsxCli(fixture.root), /escaped node_modules\/\.pnpm/)
})

test('uses the installed manager only for the reviewed v3-25 prospective set', async () => {
  const { usesInstalledPnpm } = await import(wrapperUrl.href)
  assert.equal(usesInstalledPnpm(undefined), false)
  assert.equal(usesInstalledPnpm('v2-24'), false)
  assert.equal(usesInstalledPnpm('v3-25'), true)
})

test('launches the candidate-owned pnpm CLI directly with the root-pinned version and argv', async t => {
  const { resolveRuntimePnpmCli, runtimePnpmInvocation } = await import(wrapperUrl.href)
  const fixture = await createPnpmFixture(t)

  const cliPath = await resolveRuntimePnpmCli(fixture.root)
  assert.equal(cliPath, await realpath(fixture.cliPath))
  const argv = ['run', 'build:lib', '--exit=31']
  const invocation = await runtimePnpmInvocation(fixture.root, argv)

  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.args, [cliPath, ...argv])
  const result = spawnSync(invocation.command, invocation.args, { cwd: fixture.root, encoding: 'utf8' })
  assert.equal(result.status, 31)
  assert.deepEqual(JSON.parse(result.stdout), { args: argv, cwd: fixture.root })
})

test('rejects an installed pnpm package that disagrees with the root packageManager pin', async t => {
  const { resolveRuntimePnpmCli } = await import(wrapperUrl.href)
  const fixture = await createPnpmFixture(t)
  const manifestPath = path.join(fixture.storePackage, 'package.json')
  await writeFile(manifestPath, JSON.stringify({ name: 'pnpm', version: '10.0.0', bin: { pnpm: './bin/pnpm.mjs' } }))

  await assert.rejects(resolveRuntimePnpmCli(fixture.root), /does not match the root packageManager pin/)
})
