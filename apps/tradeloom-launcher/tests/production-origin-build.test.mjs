import assert from 'node:assert/strict'
import { readFile, rm, writeFile, lstat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const privateRoot = resolve(process.env.N01_PRIVATE_TEST_ROOT ?? '')
if (!process.env.N01_PRIVATE_TEST_ROOT || privateRoot === resolve('.')) throw new Error('N01_PRIVATE_TEST_ROOT must point inside the private checkpoint marker')
const builder = join(repoRoot, 'apps/tradeloom-launcher/scripts/build-n01-origin-candidate.mjs')
const writer = join(repoRoot, 'apps/tradeloom-launcher/scripts/write-n01-origin-candidate.py')
const patchPath = join(repoRoot, 'apps/tradeloom-launcher/accepted-sdk-overrides/production-execution-origin.patch')

function assertPrivatePath(path) {
  const target = resolve(path)
  if (!target.startsWith(`${privateRoot}${sep}`)) throw new Error('refusing to write outside the N01 private marker')
  return target
}

test('JavaScript source-map builder invokes Python validator and rejects source drift', async t => {
  const nonce = randomUUID().slice(0, 8)
  const output = assertPrivatePath(join(privateRoot, `b-${nonce}`))
  const manifestInput = assertPrivatePath(`${output}.source-input`)
  const driftFile = assertPrivatePath(join(privateRoot, `build-contract-${nonce}-drift.json`))
  const outputExists = await lstat(output).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))
  const inputExists = await lstat(manifestInput).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))
  assert.equal(outputExists || inputExists, false)
  t.after(async () => {
    for (const path of [manifestInput, driftFile]) {
      const target = assertPrivatePath(path)
      await rm(target, { recursive: true, force: true })
    }
  })

  const generated = spawnSync(process.execPath, [builder, '--output', output], { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
  assert.equal(generated.status, 0, generated.stderr)
  const summary = JSON.parse(generated.stdout.trim())
  assert.equal(summary.status, 'source-map-and-sdk-pins-validated')
  assert.equal(summary.sourceFiles, 331)
  assert.equal(summary.sdkEntries, 7)
  const manifestPath = join(manifestInput, 'source-manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.sourceFiles.length, 331)
  const drift = structuredClone(manifest)
  drift.sourceFiles[0].sha256 = '0'.repeat(64)
  await writeFile(driftFile, `${JSON.stringify(drift)}\n`, { flag: 'wx' })
  const rejected = spawnSync(process.env.N01_PYTHON ?? 'python', [writer, '--manifest', driftFile, '--repo-root', repoRoot, '--patch', patchPath, '--validate-only'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /source drift:/)
})

test('Python writer fixture inventories retained base and new shell/backend entries in deployment digests', () => {
  const result = spawnSync(process.env.N01_PYTHON ?? 'python', [writer, '--fixture-inventory-test'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  const receipt = JSON.parse(result.stdout.trim())
  assert.equal(receipt.status, 'fixture-inventory-contract-valid')
  assert.equal(receipt.shell.fileCount, 2)
  assert.equal(receipt.shell.bytes, 12)
  assert.match(receipt.shell.sha256, /^[a-f0-9]{64}$/)
  assert.equal(receipt.backend.fileCount, 2)
  assert.equal(receipt.backend.bytes, 15)
  assert.match(receipt.backend.sha256, /^[a-f0-9]{64}$/)
})

test('Python writer applies a small ZIP candidate and verifies actual output readback', async t => {
  const output = assertPrivatePath(join(privateRoot, `z-${randomUUID().slice(0, 8)}`))
  const exists = await lstat(output).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))
  assert.equal(exists, false)
  t.after(async () => await rm(assertPrivatePath(output), { recursive: true, force: true }))
  const result = spawnSync(process.env.N01_PYTHON ?? 'python', [writer, '--fixture-archive-test', '--fixture-output', output], { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  const receipt = JSON.parse(result.stdout.trim())
  assert.equal(receipt.status, 'fixture-archive-readback-valid')
  assert.equal(receipt.entryCount, 7)
  assert.ok(receipt.changedEntries.includes('app/resources/tradeloom/backend/added.py'))
  assert.ok(receipt.changedEntries.includes('app/resources/tradeloom/business-shell/added.mjs'))
  assert.match(receipt.zipSha256, /^[a-f0-9]{64}$/)
  assert.equal(receipt.shell.fileCount, 2)
  assert.equal(receipt.backend.fileCount, 2)
  const { readFile } = await import('node:fs/promises')
  assert.ok((await readFile(join(output, 'fixture-candidate.zip'))).length > 0)
})

test('Python writer applies the exact six SDK patch pins and new adapter to a small ASAR fixture', async t => {
  const output = assertPrivatePath(join(privateRoot, `a-${randomUUID().slice(0, 8)}`))
  const sourceRoot = join(privateRoot, 'sdk-extracted-pin-sources')
  const command = [process.env.N01_PYTHON ?? 'python', writer, '--fixture-asar-test', '--fixture-output', output,
    '--fixture-source-root', sourceRoot, '--patch', patchPath]
  const exists = await lstat(output).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))
  assert.equal(exists, false)
  t.after(async () => await rm(assertPrivatePath(output), { recursive: true, force: true }))
  const result = spawnSync(command[0], command.slice(1), { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
  const evidencePath = assertPrivatePath(join(privateRoot, `raw-asar-${randomUUID().slice(0, 8)}.json`))
  await writeFile(evidencePath, `${JSON.stringify({ command, cwd: repoRoot, envPins: {
    N01_PRIVATE_TEST_ROOT: privateRoot, N01_SDK_NODE_MODULES: process.env.N01_SDK_NODE_MODULES ?? null,
    N01_SDK_CLIENT_BROWSER_PATH: process.env.N01_SDK_CLIENT_BROWSER_PATH ?? null,
  }, exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2)}\n`, { flag: 'wx' })
  assert.equal(result.status, 0, result.stderr)
  const receipt = JSON.parse(result.stdout.trim())
  assert.equal(receipt.status, 'fixture-asar-patch-readback-valid')
  assert.equal(receipt.entryCount, 8)
  assert.equal(receipt.sdkPostPins, 6)
  assert.deepEqual(receipt.negativeResults && Object.keys(receipt.negativeResults).sort(), ['missing', 'newEntryAlreadyExists', 'wrongPrefix', 'wrongPreimage'].sort())
  assert.equal(receipt.newAdapterPin[0], 6153)
  assert.deepEqual(receipt.alignmentResidues, [0, 1, 2, 3])
  assert.equal(receipt.fixedThreePaddingRejected, 3)
  assert.deepEqual(receipt.r76HeaderPrefix, [4, 4771700, 4771696, 4771689])
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/)
  assert.ok((await readFile(join(output, 'fixture-candidate.asar'))).length > 0)
})
