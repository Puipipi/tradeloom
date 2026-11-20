import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep, toNamespacedPath } from 'node:path'
import { spawn } from 'node:child_process'
import { createEngineGenerationSnapshots, inspectEnginePayload, fingerprintEngineGeneration, ENGINE_GENERATION_SNAPSHOT_SCOPE } from './engine-generation-snapshots.js'

const fail = code => Object.assign(new Error(code), { code })
const inside = (root, target) => { const part = relative(resolve(root), resolve(target)); return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
async function ordinary(path) {
  for (const item of [resolve(path), ...ancestors(path)]) if ((await fs.lstat(item)).isSymbolicLink()) throw fail('engine_generation_unsafe_path')
}
function* ancestors(path) { let current = dirname(resolve(path)); while (true) { yield current; const next = dirname(current); if (next === current) break; current = next } }
async function pin(path) { await ordinary(path); const info = await fs.lstat(path); if (!info.isFile()) throw fail('engine_generation_unsafe_path'); const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return { bytes: info.size, sha256: hash.digest('hex') } }
const equal = (a, b) => canonical(a) === canonical(b)
async function json(path) { await ordinary(path); return JSON.parse(await fs.readFile(path, 'utf8')) }
async function writeNew(path, value) { await fs.writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }) }

/** The only root comes from Main's identified executable installation. Renderer
 * requests contain snapshot ids and preview ids, never a root or executable. */
export async function createEngineGenerationOwner({ programRoot, env = process.env, validation, invokeApply, recoveryResources } = {}) {
  if (!isAbsolute(programRoot ?? '') || typeof validation?.validateInstalledManifest !== 'function' || typeof validation?.digestInventory !== 'function') throw fail('engine_generation_owner_unavailable')
  const target = resolve(programRoot), payload = join(target, 'app')
  await ordinary(target); await ordinary(payload)
  if ((await fs.readFile(join(payload, 'resources/tradeloom/.tradeloom-bootstrap-owned'), 'utf8')) !== 'tradeloom-bootstrap-v1\n') throw fail('engine_generation_owner_unavailable')
  const workRoot = join(dirname(target), `.${parse(target).base}-engine-recovery`)
  const activationPath = join(dirname(target), `.${parse(target).base}-engine-activation.json`)
  const leasePath = join(dirname(target), `.${parse(target).base}-engine-activation.lock`)
  const previews = new Map()
  let closed = false, lastActivation
  async function getCurrentGeneration() {
    if (closed) throw fail('engine_generation_service_closed')
    const metadata = validation.validateInstalledManifest(await json(join(payload, 'resources/tradeloom/deployment.json')))
    const entries = await inspectEnginePayload(payload)
    const inventoryHash = sha(canonical(entries))
    let active
    try { active = await json(activationPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (active && (Object.keys(active).sort().join(',') !== 'operation,payload,revision,schemaVersion,target' || active.schemaVersion !== 1 || active.target !== target || active.payload !== inventoryHash || typeof active.revision !== 'string' || typeof active.operation !== 'string')) throw fail('engine_generation_external_activation_changed')
    return { generationId: inventoryHash, runtimeVersion: metadata.sourceBuild.vendorVersion, scope: ENGINE_GENERATION_SNAPSHOT_SCOPE,
      activationRevision: active?.revision ?? `initial:${inventoryHash}`, root: payload, entries }
  }
  async function currentManifest(generation) {
    const files = generation.entries.filter(entry => entry.type === 'file').map(entry => ({ path: `app/${entry.path}`, bytes: entry.size, sha256: entry.sha256 }))
    for (const name of ['launcher.json', '启动工作台.exe']) files.push({ path: name, ...await pin(join(target, name)) })
    return { schemaVersion: 1, zipRoot: 'TradeLoom-engine-generation', files,
      tree: { files: files.length, bytes: files.reduce((sum, row) => sum + row.bytes, 0), sha256: validation.digestInventory(files) } }
  }
  const callApply = invokeApply ?? (async (operation, args, runtime) => {
    if (!runtime || !isAbsolute(runtime.python) || !isAbsolute(runtime.node) || !isAbsolute(runtime.cli)) throw fail('engine_recovery_runtime_unavailable')
    await new Promise((done, reject) => {
      const child = spawn(runtime.python, ['-B', toNamespacedPath(resolve(runtime.cli)), operation, '--target', target, '--work-root', args.work,
        ...(operation === 'apply' ? ['--candidate-root', args.candidate, '--candidate-manifest', args.candidateManifest,
          '--candidate-manifest-sha256', args.candidateManifestSha256, '--target-manifest', args.targetManifest,
          '--target-manifest-sha256', args.targetManifestSha256, '--engine-snapshot-receipt', args.receipt,
          '--engine-snapshot-sha256', args.receiptSha256, '--expected-engine-revision', args.expectedRevision] : []),
        '--activation-token', args.token, '--node', runtime.node], { cwd: dirname(runtime.cli), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      let bytes = 0
      child.stdout.on('data', chunk => { bytes += chunk.length })
      child.stderr.on('data', chunk => { bytes += chunk.length })
      child.once('error', reject)
      child.once('close', code => code === 0 && bytes < 1024 * 1024 ? done() : reject(fail('engine_activation_apply_failed')))
    })
  })
  let recoveryRuntime
  const snapshots = createEngineGenerationSnapshots({ env, getCurrentGeneration, activationAdapter: {
    async prepare({ targetSnapshot, expectedCurrent, readSnapshotFile }) {
      if (closed) throw fail('engine_generation_service_closed')
      const current = await getCurrentGeneration()
      if (current.activationRevision !== expectedCurrent.activationRevision || current.generationId !== expectedCurrent.generationId) throw fail('engine_generation_preview_stale')
      await fs.mkdir(workRoot, { recursive: true }); await ordinary(workRoot)
      const token = randomUUID(), work = join(workRoot, `transaction-${token}`), candidate = join(workRoot, `candidate-${token}`)
      const lease = await fs.open(leasePath, 'wx').catch(() => { throw fail('engine_activation_owner_conflict') })
      await lease.writeFile(JSON.stringify({ schemaVersion: 1, target, token, expectedRevision: current.activationRevision, ownerPid: process.pid }))
      await lease.close()
      let attempted = false, after, released = false
      async function assertLease() {
        const actual = await json(leasePath)
        if (actual.token !== token || actual.target !== target) throw fail('engine_activation_owner_conflict')
      }
      async function release() { await assertLease(); await fs.unlink(leasePath); released = true }
      async function reclaim() {
        if (!released) return assertLease()
        if (!after || fingerprintEngineGeneration(await getCurrentGeneration()) !== fingerprintEngineGeneration(after)) throw fail('engine_restore_rollback_owner_changed')
        const handle = await fs.open(leasePath, 'wx').catch(() => { throw fail('engine_activation_owner_conflict') })
        try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, target, token, expectedRevision: after.activationRevision, ownerPid: process.pid })) }
        finally { await handle.close() }
        released = false
        if (fingerprintEngineGeneration(await getCurrentGeneration()) !== fingerprintEngineGeneration(after)) { await release(); throw fail('engine_restore_rollback_owner_changed') }
      }
      try {
        await fs.mkdir(candidate)
        await fs.mkdir(join(candidate, 'app'))
        for (const entry of targetSnapshot.entries) {
          const destination = join(candidate, 'app', ...entry.path.split('/'))
          if (!inside(join(candidate, 'app'), destination)) throw fail('engine_generation_unsafe_path')
          if (entry.type === 'directory') await fs.mkdir(destination, { recursive: true })
          else { await fs.mkdir(dirname(destination), { recursive: true }); const bytes = await readSnapshotFile(targetSnapshot.snapshotId, entry.path); if (bytes.length !== entry.size || sha(bytes) !== entry.sha256) throw fail('engine_generation_snapshot_checksum_mismatch'); await fs.writeFile(destination, bytes, { flag: 'wx' }) }
        }
        for (const name of ['launcher.json', '启动工作台.exe']) await fs.copyFile(join(target, name), join(candidate, name), 1)
        const before = await currentManifest(current)
        const rows = targetSnapshot.entries.filter(entry => entry.type === 'file').map(entry => ({ path: `app/${entry.path}`, bytes: entry.size, sha256: entry.sha256 }))
        for (const name of ['launcher.json', '启动工作台.exe']) rows.push({ path: name, ...await pin(join(candidate, name)) })
        const next = { schemaVersion: 1, zipRoot: 'TradeLoom-engine-generation', files: rows,
          tree: { files: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), sha256: validation.digestInventory(rows) } }
        const parent = join(workRoot, `receipts-${token}`); await fs.mkdir(parent)
        const beforePath = join(parent, 'before.json'), nextPath = join(parent, 'candidate.json'), receipt = join(parent, 'snapshot.json')
        await writeNew(beforePath, before); await writeNew(nextPath, next)
        await writeNew(receipt, { schemaVersion: 1, scope: ENGINE_GENERATION_SNAPSHOT_SCOPE, target, token,
          snapshot: targetSnapshot, candidateManifest: await pin(nextPath), expectedRevision: current.activationRevision })
        const args = { work, candidate, candidateManifest: nextPath, candidateManifestSha256: (await pin(nextPath)).sha256,
          targetManifest: beforePath, targetManifestSha256: (await pin(beforePath)).sha256, receipt, receiptSha256: (await pin(receipt)).sha256,
          expectedRevision: current.activationRevision, token }
        lastActivation = { work, token, before: current, targetGenerationId: targetSnapshot.generationId }
        return {
          async commit() {
            await assertLease()
            if (fingerprintEngineGeneration(await getCurrentGeneration()) !== fingerprintEngineGeneration(current)) throw fail('engine_generation_preview_stale')
            attempted = true
            await callApply('apply', args, recoveryRuntime)
            after = await getCurrentGeneration()
            if (after.generationId !== targetSnapshot.generationId) throw fail('engine_activation_readback_mismatch')
            await release()
          },
          async rollback() {
            // A newer activation is never overwritten in order to make an old
            // caller report success. CLI rollback has the same exact-tree fence.
            await reclaim()
            if (attempted) {
              let journal
              try { journal = await json(join(work, 'state.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
              if (journal) {
                if (journal.target !== target || journal.work !== work || journal.activationToken !== token) throw fail('engine_restore_rollback_owner_changed')
                // CLI itself fences the actual before/after tree, activation
                // revision, wrapper and config. A failed child may already have
                // restored, or may have left a journal at any rename boundary.
                if (journal.phase === 'complete') await callApply('rollback', args, recoveryRuntime)
                else if (journal.phase !== 'restored') await callApply('recover', args, recoveryRuntime)
              }
              const restored = await getCurrentGeneration()
              if (restored.generationId !== current.generationId) throw fail('engine_restore_rollback_readback_mismatch')
            }
            if (!released) await release()
          },
        }
      } catch (error) { try { await release() } catch {} throw error }
    },
  } })
  return Object.freeze({
    getCurrentGeneration,
    /** Worker-only, one existing transaction: no directory search or guessed
     * recovery. Both full payload and this journal's activation owner must match. */
    async readRecoveryOutcome(expectedFingerprint) {
      let current
      try { current = await getCurrentGeneration() } catch { return { status: 'unknown', safeToRestart: false } }
      try { await fs.lstat(leasePath); return { status: 'unknown', safeToRestart: false } }
      catch (error) { if (error.code !== 'ENOENT') return { status: 'unknown', safeToRestart: false } }
      if (!lastActivation) return { status: fingerprintEngineGeneration(current) === expectedFingerprint ? 'failed-unchanged' : 'unknown', safeToRestart: fingerprintEngineGeneration(current) === expectedFingerprint }
      let journal
      try { journal = await json(join(lastActivation.work, 'state.json')) } catch (error) {
        if (error.code !== 'ENOENT') return { status: 'unknown', safeToRestart: false }
        const unchanged = fingerprintEngineGeneration(current) === fingerprintEngineGeneration(lastActivation.before)
        return { status: unchanged ? 'failed-unchanged' : 'unknown', safeToRestart: unchanged }
      }
      if (journal.target !== target || journal.work !== lastActivation.work || journal.activationToken !== lastActivation.token) return { status: 'unknown', safeToRestart: false }
      const active = await json(activationPath).catch(() => null)
      if (!active || active.operation !== lastActivation.work) return { status: 'unknown', safeToRestart: false }
      if (journal.phase === 'complete' && current.generationId === lastActivation.targetGenerationId && active.revision === journal.activationAfter) return { status: 'restored', safeToRestart: true }
      if (journal.phase === 'restored' && current.generationId === lastActivation.before.generationId && active.revision === journal.activationRestored) return { status: 'rolled-back', safeToRestart: true }
      return { status: 'unknown', safeToRestart: false }
    },
    capture: () => snapshots.capture(), list: () => snapshots.list(),
    async previewRestore(snapshotId) {
      const preview = await snapshots.previewRestore(snapshotId)
      previews.set(preview.previewId, { snapshotId, fingerprint: fingerprintEngineGeneration(await getCurrentGeneration()) })
      return preview
    },
    cancelRestorePreview(id) { previews.delete(id); return snapshots.cancelRestorePreview(id) },
    /** Worker-only after the exact Main and its target children are stopped. */
    async restoreStopped(snapshotId, expectedFingerprint, runtime) {
      recoveryRuntime = runtime
      if (fingerprintEngineGeneration(await getCurrentGeneration()) !== expectedFingerprint) throw fail('engine_generation_preview_stale')
      const preview = await snapshots.previewRestore(snapshotId)
      return snapshots.restore(preview.previewId)
    },
    async prepareWorker(previewId, mainIdentity) {
      const selected = previews.get(previewId)
      if (!selected || selected.fingerprint !== fingerprintEngineGeneration(await getCurrentGeneration())) throw fail('engine_generation_preview_stale')
      if (!recoveryResources || recoveryResources.schemaVersion !== 1 || !Array.isArray(recoveryResources.files) || !Number.isSafeInteger(mainIdentity?.pid) || typeof mainIdentity.creation !== 'string') throw fail('engine_recovery_runtime_unavailable')
      await fs.mkdir(workRoot, { recursive: true }); await ordinary(workRoot)
      const directory = join(workRoot, `worker-${randomUUID()}`); await fs.mkdir(directory)
      const copied = []
      for (const row of recoveryResources.files) {
        if (typeof row.source !== 'string' || typeof row.path !== 'string') throw fail('engine_recovery_runtime_unavailable')
        const source = join(target, ...row.source.split('/')), destination = join(directory, ...row.path.split('/'))
        if (!inside(join(target, 'app/resources'), source) || !inside(directory, destination) || !equal(await pin(source), { bytes: row.bytes, sha256: row.sha256 })) throw fail('engine_recovery_runtime_drift')
        await fs.mkdir(dirname(destination), { recursive: true }); await fs.copyFile(source, destination, 1)
        if (!equal(await pin(destination), { bytes: row.bytes, sha256: row.sha256 })) throw fail('engine_recovery_runtime_drift')
        copied.push({ path: row.path, bytes: row.bytes, sha256: row.sha256 })
      }
      for (const key of ['node', 'python', 'worker', 'owner', 'validator', 'cli']) if (!copied.some(row => row.path === recoveryResources[key])) throw fail('engine_recovery_runtime_unavailable')
      const requestPath = join(directory, 'request.json')
      const request = { schemaVersion: 1, target, directory, main: mainIdentity, files: copied,
        runtime: Object.fromEntries(['node', 'python', 'worker', 'owner', 'validator', 'cli'].map(key => [key, recoveryResources[key]])),
        snapshotId: selected.snapshotId, expectedFingerprint: selected.fingerprint,
        home: { DSH_HOME: env.DSH_HOME, TRADELOOM_DSH_APP_HOME: env.TRADELOOM_DSH_APP_HOME }, launcher: await pin(join(target, '启动工作台.exe')), launcherConfig: await pin(join(target, 'launcher.json')) }
      await writeNew(requestPath, request)
      previews.delete(previewId); snapshots.cancelRestorePreview(previewId)
      return { requestPath, requestSha256: (await pin(requestPath)).sha256, node: join(directory, recoveryResources.node), worker: join(directory, recoveryResources.worker) }
    },
    async dispose() { closed = true; previews.clear(); await snapshots.dispose() },
  })
}
