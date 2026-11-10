import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { createEngineGenerationSnapshots } from '../engine-generation-snapshots.js'
import { HOME_MARKER, HOME_MARKER_VALUE } from '../state.js'

const fixtureRoot = process.env.TRADELOOM_ENGINE_GENERATION_TEST_ROOT
if (!fixtureRoot) throw new Error('TRADELOOM_ENGINE_GENERATION_TEST_ROOT must point to the owned test root')
await mkdir(fixtureRoot, { recursive: true })
const fixtureRootReal = await import('node:fs/promises').then(({ realpath }) => realpath(fixtureRoot))
assert.equal((await readFile(join(fixtureRootReal, '.n03-engine-generation-owned'), 'utf8')).trim(), 'tradeloom-engine-generation-test-root-v1')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function inventory(root) {
  const entries = []
  async function visit(directory, prefix = '') {
    const names = (await readdir(directory)).sort()
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name
      const path = join(directory, name)
      const info = await lstat(path)
      assert.equal(info.isSymbolicLink(), false)
      if (info.isDirectory()) {
        entries.push({ path: rel, type: 'directory' })
        await visit(path, rel)
      } else {
        const bytes = await readFile(path)
        entries.push({ path: rel, type: 'file', size: bytes.length, sha256: sha256(bytes) })
      }
    }
  }
  await visit(root)
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

async function writePayload(root, value) {
  await mkdir(join(root, 'bin'), { recursive: true })
  await mkdir(join(root, 'assets', 'empty'), { recursive: true })
  await writeFile(join(root, 'bin', 'engine.dat'), value)
  await writeFile(join(root, 'version.txt'), 'runtime fixture\n')
}

async function replacePayload(root, value) {
  for (const child of await readdir(root)) await rm(join(root, child), { recursive: true, force: true })
  await writePayload(root, value)
}

async function createFixture(t, { activation = true, activationOptions = {}, sourceInsideSnapshotStore = false, snapshotHooks } = {}) {
  const fixtureId = randomUUID()
  const home = join(fixtureRootReal, `owned-${fixtureId}`)
  await mkdir(home, { recursive: false })
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  let sourceOwnerRoot
  const sourceRoot = sourceInsideSnapshotStore
    ? join(home, 'tradeloom-engine-generation-snapshots', 'source-payload')
    : join(fixtureRootReal, `runtime-${fixtureId}`, 'active-generation')
  if (!sourceInsideSnapshotStore) {
    sourceOwnerRoot = dirname(sourceRoot)
    await mkdir(sourceOwnerRoot, { recursive: true })
    await writeFile(join(sourceOwnerRoot, '.n03-engine-source-owned'), 'tradeloom-engine-generation-source-v1\n')
  }
  await mkdir(dirname(sourceRoot), { recursive: true })
  await mkdir(sourceRoot)
  await writePayload(sourceRoot, 'generation-A')
  const current = {
    generationId: 'generation-A',
    runtimeVersion: 'fixture-runtime-1',
    scope: 'tradeloom-engine-payload/v1',
    activationRevision: 'activation-1',
    root: sourceRoot,
  }
  let inventoryTransform
  const env = { DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home }
  const getCurrentGeneration = async () => {
    const entries = await inventory(sourceRoot)
    return { ...current, entries: inventoryTransform ? inventoryTransform(entries) : entries }
  }
  const activationAdapter = activation ? createFilesystemActivationAdapter({ home, sourceRoot, current, ...activationOptions }) : undefined
  const service = createEngineGenerationSnapshots({ env, getCurrentGeneration, activationAdapter, _testHooks: snapshotHooks })
  const ownedPath = await import('node:fs/promises').then(({ realpath }) => realpath(home))
  assert.equal(dirname(ownedPath), fixtureRootReal)
  if (sourceOwnerRoot) assert.equal(dirname(await import('node:fs/promises').then(({ realpath }) => realpath(sourceOwnerRoot))), fixtureRootReal)
  t.after(async () => {
    const resolved = await import('node:fs/promises').then(({ realpath }) => realpath(home).catch(() => undefined))
    if (resolved && dirname(resolved) === fixtureRootReal && await readFile(join(resolved, HOME_MARKER), 'utf8').then(value => value === HOME_MARKER_VALUE, () => false)) {
      await service.dispose()
      await rm(resolved, { recursive: true, force: true })
    }
    if (sourceOwnerRoot) {
      const sourceResolved = await import('node:fs/promises').then(({ realpath }) => realpath(sourceOwnerRoot).catch(() => undefined))
      if (sourceResolved && dirname(sourceResolved) === fixtureRootReal
        && await readFile(join(sourceResolved, '.n03-engine-source-owned'), 'utf8').then(value => value === 'tradeloom-engine-generation-source-v1\n', () => false)) {
        await rm(sourceResolved, { recursive: true, force: true })
      }
    }
  })
  return { home, sourceRoot, current, service, setInventoryTransform(value) { inventoryTransform = value } }
}

function createFilesystemActivationAdapter({ home, sourceRoot, current, mismatchReadback = false, failRollback = false, failCommitBefore = false, failCommitAfter = false, onCommit, commitError, rollbackError }) {
  return {
    async prepare({ targetSnapshot, backupSnapshot, readSnapshotFile, expectedCurrent }) {
      const transactionRoot = join(home, `activation-${randomUUID()}`)
      const targetStage = join(transactionRoot, 'target')
      const backupStage = join(transactionRoot, 'backup')
      await mkdir(targetStage, { recursive: true })
      await mkdir(backupStage, { recursive: true })
      for (const entry of targetSnapshot.entries) {
        const destination = join(targetStage, ...entry.path.split('/'))
        if (entry.type === 'directory') await mkdir(destination, { recursive: true })
        else {
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, await readSnapshotFile(targetSnapshot.snapshotId, entry.path), { flag: 'wx' })
        }
      }
      for (const entry of backupSnapshot.entries) {
        const destination = join(backupStage, ...entry.path.split('/'))
        if (entry.type === 'directory') await mkdir(destination, { recursive: true })
        else {
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, await readSnapshotFile(backupSnapshot.snapshotId, entry.path), { flag: 'wx' })
        }
      }
      const original = { ...current }
      let movedCurrent
      let committed = false
      return {
        async commit() {
          if (failCommitBefore) throw commitError ?? Object.assign(new Error('activation fixture rejection'), { code: 'engine_activation_conflict' })
          if (current.activationRevision !== expectedCurrent.activationRevision) throw Object.assign(new Error('stale'), { code: 'engine_activation_conflict' })
          await onCommit?.()
          movedCurrent = join(transactionRoot, 'previous-current')
          await rename(sourceRoot, movedCurrent)
          await rename(targetStage, sourceRoot)
          current.generationId = targetSnapshot.generationId
          current.runtimeVersion = targetSnapshot.runtimeVersion
          current.scope = targetSnapshot.scope
          current.activationRevision = 'activation-after-commit'
          committed = true
          if (mismatchReadback) current.generationId = 'unexpected-generation'
          if (failCommitAfter) throw commitError ?? Object.assign(new Error('activation fixture failure after commit'), { code: 'engine_activation_conflict' })
        },
        async rollback({ phase } = {}) {
          if (failRollback) throw rollbackError ?? Object.assign(new Error('rollback fixture failure'), { code: 'engine_activation_rollback_failed' })
          if (phase === 'prepared') {
            await rm(transactionRoot, { recursive: true, force: true })
            return
          }
          if (!committed && !movedCurrent) {
            await rm(transactionRoot, { recursive: true, force: true })
            return
          }
          if (committed) {
            const failed = join(transactionRoot, 'failed-target')
            await rename(sourceRoot, failed)
            await rename(backupStage, sourceRoot)
          } else if (movedCurrent) {
            await rename(movedCurrent, sourceRoot)
          }
          Object.assign(current, original, { activationRevision: 'activation-after-rollback' })
        },
      }
    },
  }
}

test('normal package exports expose the engine generation snapshot service', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.exports['./engine-generation-snapshots'], './engine-generation-snapshots.js')
  assert.ok(packageJson.files.includes('engine-generation-snapshots.js'))
  const imported = await import('@tradeloom/dsh-business-shell/engine-generation-snapshots')
  assert.equal(typeof imported.createEngineGenerationSnapshots, 'function')
})

test('capture copies exact complete payload including empty directories and exports checksummed metadata only', async t => {
  const { sourceRoot, service } = await createFixture(t)
  const snapshot = await service.capture()
  const captured = await service.export(snapshot.snapshotId)
  assert.equal(snapshot.generationId, 'generation-A')
  assert.equal(snapshot.scope, 'tradeloom-engine-payload/v1')
  assert.equal(captured.entries.some(entry => entry.path === 'assets/empty' && entry.type === 'directory'), true)
  assert.equal(captured.entries.find(entry => entry.path === 'bin/engine.dat').sha256, sha256(Buffer.from('generation-A')))
  await writeFile(join(sourceRoot, 'bin', 'engine.dat'), 'changed after capture')
  const exported = await service.export(snapshot.snapshotId)
  assert.deepEqual(exported.entries, captured.entries)
  assert.equal(Object.hasOwn(exported, 'payload'), false)
  assert.equal((await service.list()).snapshots[0].snapshotId, snapshot.snapshotId)
})

test('capture rejects missing or extra source entries without publishing a snapshot', async t => {
  const { sourceRoot, service, setInventoryTransform } = await createFixture(t)
  const snapshot = await service.capture()
  await writeFile(join(sourceRoot, 'extra.bin'), 'extra')
  setInventoryTransform(entries => entries.filter(entry => entry.path !== 'extra.bin'))
  await assert.rejects(service.capture(), error => error.code === 'engine_generation_inventory_mismatch')
  assert.equal((await service.list()).snapshots.length, 1)
  await rm(join(sourceRoot, 'extra.bin'))
  setInventoryTransform(entries => entries.filter(entry => entry.path !== 'version.txt'))
  await assert.rejects(service.capture(), error => error.code === 'engine_generation_inventory_mismatch')
  assert.equal((await service.list()).snapshots.length, 1)
  assert.equal(snapshot.snapshotId.length > 0, true)
})

test('capture refuses storage nested in the source payload tree', async t => {
  const { service } = await createFixture(t, { activation: false, sourceInsideSnapshotStore: true })
  await assert.rejects(service.capture(), error => error.code === 'engine_generation_source_overlap')
})

test('preview rejects a different engine payload scope without creating a backup', async t => {
  let commits = 0
  const { sourceRoot, current, service } = await createFixture(t, { activationOptions: { onCommit() { commits += 1 } } })
  const snapshot = await service.capture()
  await replacePayload(sourceRoot, 'generation-B')
  current.generationId = 'generation-B'
  current.runtimeVersion = 'fixture-runtime-2'
  current.scope = 'another-engine-scope/v1'
  current.activationRevision = 'activation-2'
  await assert.rejects(service.previewRestore(snapshot.snapshotId), error => error.code === 'engine_generation_scope_mismatch')
  assert.equal((await service.list()).snapshots.length, 1)
  assert.equal(commits, 0)
  assert.equal(await readFile(join(sourceRoot, 'bin', 'engine.dat'), 'utf8'), 'generation-B')
})

test('preview and cancel are read only; restore without launcher activation is unavailable', async t => {
  const { home, sourceRoot, current, service } = await createFixture(t, { activation: false })
  const snapshot = await service.capture()
  await replacePayload(sourceRoot, 'generation-B')
  current.generationId = 'generation-B'
  current.activationRevision = 'activation-2'
  const before = await inventory(sourceRoot)
  const preview = await service.previewRestore(snapshot.snapshotId)
  assert.equal(preview.restorable, false)
  assert.ok(preview.changes.changed.includes('bin/engine.dat'))
  assert.equal(await service.cancelRestorePreview(preview.previewId), true)
  assert.deepEqual(await inventory(sourceRoot), before)
  await assert.rejects(service.restore(preview.previewId), error => error.code === 'engine_generation_restore_preview_not_found')
  const fresh = await service.previewRestore(snapshot.snapshotId)
  await assert.rejects(service.restore(fresh.previewId), error => error.code === 'engine_restore_unavailable')
  assert.equal((await service.list()).snapshots.length, 1)
  assert.equal((await inventory(sourceRoot)).length, before.length)
  assert.equal((await readdir(home)).includes('tradeloom-engine-generation-snapshots'), true)
})

test('successful restore captures current bytes as backup then physically restores target payload', async t => {
  const { sourceRoot, current, service } = await createFixture(t)
  const target = await service.capture()
  const targetSnapshot = await service.export(target.snapshotId)
  await replacePayload(sourceRoot, 'generation-B')
  current.generationId = 'generation-B'
  current.runtimeVersion = 'fixture-runtime-2'
  current.activationRevision = 'activation-2'
  const preview = await service.previewRestore(target.snapshotId)
  const result = await service.restore(preview.previewId)
  assert.equal(result.status, 'restored')
  assert.equal(result.active.generationId, 'generation-A')
  assert.equal(await readFile(join(sourceRoot, 'bin', 'engine.dat'), 'utf8'), 'generation-A')
  assert.deepEqual(await inventory(sourceRoot), targetSnapshot.entries)
  const backup = await service.export(result.backupSnapshotId)
  assert.equal(backup.kind, 'pre-restore-backup')
  assert.equal(backup.generationId, 'generation-B')
  assert.equal(backup.entries.find(entry => entry.path === 'bin/engine.dat').sha256, sha256(Buffer.from('generation-B')))
})

test('restore rejects an activation revision change after preview before creating a backup', async t => {
  const { sourceRoot, current, service } = await createFixture(t)
  const snapshot = await service.capture()
  await replacePayload(sourceRoot, 'generation-B')
  current.generationId = 'generation-B'
  current.activationRevision = 'activation-2'
  const preview = await service.previewRestore(snapshot.snapshotId)
  current.activationRevision = 'activation-3'
  const before = await inventory(sourceRoot)
  await assert.rejects(service.restore(preview.previewId), error => error.code === 'engine_generation_preview_stale')
  assert.deepEqual(await inventory(sourceRoot), before)
  assert.equal((await service.list()).length ?? (await service.list()).snapshots.length, 1)
})

test('one preview can start only one concurrent restore', async t => {
  let commits = 0
  const { sourceRoot, current, service } = await createFixture(t, { activationOptions: { onCommit() { commits += 1 } } })
  const target = await service.capture()
  await replacePayload(sourceRoot, 'generation-B')
  current.generationId = 'generation-B'
  current.runtimeVersion = 'fixture-runtime-2'
  current.activationRevision = 'activation-2'
  const preview = await service.previewRestore(target.snapshotId)
  const outcomes = await Promise.allSettled([service.restore(preview.previewId), service.restore(preview.previewId)])
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = outcomes.find(result => result.status === 'rejected')
  assert.equal(rejected.reason.code, 'engine_generation_restore_preview_not_found')
  assert.equal(commits, 1)
  assert.equal(await readFile(join(sourceRoot, 'bin', 'engine.dat'), 'utf8'), 'generation-A')
})

test('dispose waits for an activation already inside commit and verifies readback', async t => {
  let entered
  let release
  const enteredCommit = new Promise(resolve => { entered = resolve })
  const holdCommit = new Promise(resolve => { release = resolve })
  const { sourceRoot, current, service } = await createFixture(t, {
    activationOptions: { onCommit() { entered(); return holdCommit } },
  })
  const target = await service.capture()
  await replacePayload(sourceRoot, 'generation-B')
  current.generationId = 'generation-B'
  current.runtimeVersion = 'fixture-runtime-2'
  current.activationRevision = 'activation-2'
  const preview = await service.previewRestore(target.snapshotId)
  const restoring = service.restore(preview.previewId)
  await enteredCommit
  const disposing = service.dispose()
  release()
  const result = await restoring
  await disposing
  assert.equal(result.status, 'restored')
  assert.equal(result.active.generationId, 'generation-A')
  assert.equal(await readFile(join(sourceRoot, 'bin', 'engine.dat'), 'utf8'), 'generation-A')
})

test('verified backup is returned when activation fails before changing active files', async t => {
  const activationError = Object.assign(new Error('private activation detail'), { code: 'engine_activation_conflict' })
  const { sourceRoot, current, service } = await createFixture(t, { activationOptions: { failCommitBefore: true, commitError: activationError } })
  const target = await service.capture()
  await replacePayload(sourceRoot, 'generation-B')
  current.generationId = 'generation-B'
  current.runtimeVersion = 'fixture-runtime-2'
  current.activationRevision = 'activation-2'
  const preview = await service.previewRestore(target.snapshotId)
  const error = await service.restore(preview.previewId).then(() => null, value => value)
  assert.equal(error.code, 'engine_restore_failed', error.stack)
  assert.equal(error.failureCode, 'engine_activation_conflict')
  assert.equal(error.cause, activationError)
  assert.equal(JSON.stringify(error).includes('private activation detail'), false)
  assert.ok(error.backupSnapshotId)
  assert.equal(await readFile(join(sourceRoot, 'bin', 'engine.dat'), 'utf8'), 'generation-B')
  assert.equal((await service.export(error.backupSnapshotId)).kind, 'pre-restore-backup')
})

test('backup publish failure leaves the active generation unchanged', async t => {
  const { sourceRoot, current, service } = await createFixture(t, {
    snapshotHooks: { async beforeSnapshotPublish({ kind }) { if (kind === 'pre-restore-backup') throw new Error('fixture publish failure') } },
  })
  const target = await service.capture()
  await replacePayload(sourceRoot, 'generation-B')
  current.generationId = 'generation-B'
  current.runtimeVersion = 'fixture-runtime-2'
  current.activationRevision = 'activation-2'
  const preview = await service.previewRestore(target.snapshotId)
  await assert.rejects(service.restore(preview.previewId), error => error.code === 'engine_generation_backup_write_failed')
  assert.equal(await readFile(join(sourceRoot, 'bin', 'engine.dat'), 'utf8'), 'generation-B')
  assert.equal((await service.list()).snapshots.length, 1)
})

test('readback mismatch rolls back original files and returns verified backup identity', async t => {
  const { sourceRoot, current, service } = await createFixture(t, { activationOptions: { mismatchReadback: true } })
  const target = await service.capture()
  await replacePayload(sourceRoot, 'generation-B')
  current.generationId = 'generation-B'
  current.runtimeVersion = 'fixture-runtime-2'
  current.activationRevision = 'activation-2'
  const preview = await service.previewRestore(target.snapshotId)
  const error = await service.restore(preview.previewId).then(() => null, value => value)
  assert.equal(error.code, 'engine_restore_failed', error.stack)
  assert.equal(error.failureCode, 'engine_activation_readback_mismatch')
  assert.ok(error.backupSnapshotId)
  assert.equal(await readFile(join(sourceRoot, 'bin', 'engine.dat'), 'utf8'), 'generation-B')
  const backup = await service.export(error.backupSnapshotId)
  assert.equal(backup.generationId, 'generation-B')
  assert.deepEqual(await inventory(sourceRoot), backup.entries)
})

test('rollback failure reports unknown active state while retaining the verified backup', async t => {
  const activationError = Object.assign(new Error('private activation detail'), { code: 'engine_activation_readback_mismatch' })
  const rollbackError = Object.assign(new Error('private rollback detail'), { code: 'engine_activation_rollback_failed' })
  const { home, sourceRoot, current, service } = await createFixture(t, { activationOptions: {
    failCommitAfter: true, failRollback: true, commitError: activationError, rollbackError,
  } })
  const target = await service.capture()
  await replacePayload(sourceRoot, 'generation-B')
  current.generationId = 'generation-B'
  current.runtimeVersion = 'fixture-runtime-2'
  current.activationRevision = 'activation-2'
  const preview = await service.previewRestore(target.snapshotId)
  const error = await service.restore(preview.previewId).then(() => null, value => value)
  assert.equal(error.code, 'engine_restore_rollback_failed', error.stack)
  assert.equal(error.failureCode, 'engine_activation_readback_mismatch')
  assert.equal(error.cause, activationError)
  assert.equal(error.rollbackCause, rollbackError)
  assert.equal(JSON.stringify(error).includes('private rollback detail'), false)
  assert.ok(error.backupSnapshotId)
  assert.equal((await service.export(error.backupSnapshotId)).kind, 'pre-restore-backup')
  assert.equal(await lstat(join(home, 'tradeloom-engine-generation-snapshots', error.backupSnapshotId)).then(info => info.isDirectory()), true)
})

test('corrupt snapshot payload is rejected before activation', async t => {
  const { home, service } = await createFixture(t)
  const snapshot = await service.capture()
  const payload = join(home, 'tradeloom-engine-generation-snapshots', snapshot.snapshotId, 'payload', 'bin', 'engine.dat')
  await writeFile(payload, 'tampered')
  await assert.rejects(service.export(snapshot.snapshotId), error => error.code === 'engine_generation_snapshot_checksum_mismatch')
})
