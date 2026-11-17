// Small real filesystem/actual CLI fixtures, NOT a complete engine/application
// acceptance. Only controlled no-window fixture executables are launched;
// no actual TradeLoom wrapper, Host/service or model is started.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm, cp, copyFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createEngineGenerationOwner } from '../engine-generation-owner.js'
import { fingerprintEngineGeneration } from '../engine-generation-snapshots.js'
import { HOME_MARKER, HOME_MARKER_VALUE } from '../state.js'
import * as validation from '../../../apps/tradeloom-launcher/installed-bootstrap.mjs'

const execute = promisify(execFile), R = fileURLToPath(new URL('../../../', import.meta.url))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t, afterApply, rootParent = tmpdir(), retention = { keep: false }) {
  assert.ok(process.env.TL_SEVEN_PYTHON, 'explicit existing Python test runtime required')
  const root = await mkdtemp(join(rootParent, 'tl-engine-owner-')), program = join(root, 'program'), home = join(root, 'owned-home')
  t.after(() => retention.keep ? undefined : rm(root, { recursive: true, force: true }))
  await mkdir(home); await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  const resources = join(program, 'app/resources/tradeloom'), shell = join(resources, 'business-shell')
  await mkdir(shell, { recursive: true })
  await writeFile(join(resources, '.tradeloom-bootstrap-owned'), 'tradeloom-bootstrap-v1\n')
  const config = Buffer.from(JSON.stringify({ schemaVersion: 2, dataDirectory: home, hostPort: 3088, djangoPort: 3090, postgresPort: 55432 }))
  await writeFile(join(program, 'launcher.json'), config)
  await writeFile(join(program, '启动工作台.exe'), 'controlled fixture: never execute')
  await writeFile(join(program, 'app/payload.bin'), 'old generation')
  const packageBytes = Buffer.from(JSON.stringify({ name: '@tradeloom/dsh-business-shell', version: 'fixture', files: ['fixture.js'] })), code = Buffer.from('export {}\n')
  await writeFile(join(shell, 'package.json'), packageBytes); await writeFile(join(shell, 'fixture.js'), code)
  const rows = [{ path: 'fixture.js', bytes: code.length, sha256: sha(code) }, { path: 'package.json', bytes: packageBytes.length, sha256: sha(packageBytes) }]
  const business = { root: 'resources/tradeloom/business-shell', version: 'fixture', fileCount: rows.length, bytes: rows.reduce((n, r) => n + r.bytes, 0), sha256: validation.digestInventory(rows) }
  // Call the actual metadata builder function; no builder main/replay executes.
  const script = "import importlib.util,json,sys,hashlib;from pathlib import Path;r=Path(sys.argv[1]);s=importlib.util.spec_from_file_location('builder',r/'scripts/build-dsh-candidate.py');b=importlib.util.module_from_spec(s);s.loader.exec_module(b);k=r/'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2';p=b.replay.load(k/'program-recipe.json');q=b.replay.load(k/'recipe.json');z=hashlib.sha256(b'').hexdigest();resources={**p['programResources'],'businessShell':json.loads(sys.argv[2]),'business':{'root':'resources/tradeloom/backend','fileCount':4,'bytes':4,'sha256':z,'files':[{'path':n,'bytes':1,'sha256':z} for n in ['manage.py','requirements-workbench.txt','config/settings.py','workbench/__init__.py']]}};print(json.dumps(b.deployment_metadata(p,q,b.replay.load(k/'desktop-recipe.json'),resources,'controlled-fixture',True,z,{'fixture.patch':z})))"
  const metadata = JSON.parse((await execute(process.env.TL_SEVEN_PYTHON, ['-B', '-c', script, R, JSON.stringify(business)], { windowsHide: true, maxBuffer: 256 * 1024 })).stdout)
  validation.validateInstalledManifest(metadata)
  await writeFile(join(resources, 'deployment.json'), JSON.stringify(metadata))
  let calls = []
  const invokeApply = async (operation, args, runtime) => {
    calls.push(operation)
    const argv = ['-B', join(R, 'scripts/apply-dsh-candidate.py'), operation, '--target', program, '--work-root', args.work, '--activation-token', args.token, '--node', process.execPath]
    if (operation === 'apply') argv.push('--candidate-root', args.candidate, '--candidate-manifest', args.candidateManifest, '--candidate-manifest-sha256', args.candidateManifestSha256,
      '--target-manifest', args.targetManifest, '--target-manifest-sha256', args.targetManifestSha256, '--engine-snapshot-receipt', args.receipt, '--engine-snapshot-sha256', args.receiptSha256,
      '--expected-engine-revision', args.expectedRevision)
    await execute(process.env.TL_SEVEN_PYTHON, argv, { windowsHide: true, maxBuffer: 1024 * 1024 })
    if (operation === 'apply' && afterApply) await afterApply(program)
  }
  const owner = await createEngineGenerationOwner({ programRoot: program, validation, invokeApply,
    env: { DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home } })
  t.after(() => owner.dispose())
  return { owner, root, program, home, config, calls, runtime: { python: process.env.TL_SEVEN_PYTHON, node: process.execPath, cli: join(R, 'scripts/apply-dsh-candidate.py') } }
}

test('full owned payload snapshot restores through the actual CLI/native-fs validator and reads back a new activation', async t => {
  const f = await fixture(t), snapshot = await f.owner.capture()
  await writeFile(join(f.program, 'app/payload.bin'), 'new controlled generation')
  const current = await f.owner.getCurrentGeneration(), preview = await f.owner.previewRestore(snapshot.snapshotId)
  assert.equal(preview.restorable, true)
  await f.owner.restoreStopped(snapshot.snapshotId, fingerprintEngineGeneration(current), f.runtime)
  assert.deepEqual(await f.owner.readRecoveryOutcome(fingerprintEngineGeneration(current)), { status: 'restored', safeToRestart: true })
  assert.equal(await readFile(join(f.program, 'app/payload.bin'), 'utf8'), 'old generation')
  assert.deepEqual(await readFile(join(f.program, 'launcher.json')), f.config)
  assert.notEqual((await f.owner.getCurrentGeneration()).activationRevision, current.activationRevision)
  assert.deepEqual(f.calls, ['apply'])
  await assert.rejects(lstat(join(f.root, '.program-engine-activation.lock')), { code: 'ENOENT' })
})

test('stale confirmation does not start CLI; child failure after actual commit recovers its own before tree', async t => {
  const f = await fixture(t, async () => { throw Error('controlled child response failure after actual apply') })
  const snapshot = await f.owner.capture()
  await writeFile(join(f.program, 'app/payload.bin'), 'new controlled generation')
  const generation = await f.owner.getCurrentGeneration()
  await assert.rejects(f.owner.restoreStopped(snapshot.snapshotId, 'stale-fingerprint', f.runtime), { code: 'engine_generation_preview_stale' })
  assert.deepEqual(f.calls, [])
  await assert.rejects(f.owner.restoreStopped(snapshot.snapshotId, fingerprintEngineGeneration(generation), f.runtime))
  assert.deepEqual(f.calls, ['apply', 'rollback'])
  assert.equal(await readFile(join(f.program, 'app/payload.bin'), 'utf8'), 'new controlled generation')
  assert.deepEqual(await f.owner.readRecoveryOutcome(fingerprintEngineGeneration(generation)), { status: 'rolled-back', safeToRestart: true })
  await assert.rejects(lstat(join(f.root, '.program-engine-activation.lock')), { code: 'ENOENT' })
})

test('a third-party generation after apply is preserved and leaves recovery evidence/lock, never overwritten by the old job', async t => {
  const f = await fixture(t, async program => writeFile(join(program, 'app/payload.bin'), 'third-party generation'))
  const snapshot = await f.owner.capture(); await writeFile(join(f.program, 'app/payload.bin'), 'new controlled generation')
  const generation = await f.owner.getCurrentGeneration()
  await assert.rejects(f.owner.restoreStopped(snapshot.snapshotId, fingerprintEngineGeneration(generation), f.runtime))
  assert.equal(await readFile(join(f.program, 'app/payload.bin'), 'utf8'), 'third-party generation')
  assert.ok((await lstat(join(f.root, '.program-engine-activation.lock'))).isFile())
  assert.deepEqual(await f.owner.readRecoveryOutcome(fingerprintEngineGeneration(generation)), { status: 'unknown', safeToRestart: false })
})

test('recovery worker waits exact normal Main exit, refuses remaining target services and normally reopens only verified payload', async t => {
  assert.ok(process.env.TL_SEVEN_TEST_ROOT, 'explicit private synthetic root required')
  const f = await fixture(t, undefined, process.env.TL_SEVEN_TEST_ROOT)
  const worker = createRequire(import.meta.url)(join(R, 'apps/tradeloom-launcher/engine-recovery-worker.cjs'))
  const compiler = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  const mainPath = join(f.program, 'app/controlled-main.exe'), marker = join(f.root, 'reopened.txt')
  const waitingSource = join(f.root, 'Wait.cs'), launcherSource = join(f.root, 'Reopen.cs')
  await writeFile(waitingSource, 'using System;class Wait{static void Main(){Console.WriteLine("waiting");Console.ReadLine();}}')
  await writeFile(launcherSource, 'using System.IO;class Reopen{static void Main(){File.WriteAllText(@"' + marker.replaceAll('"', '""') + '","normal-reopen");}}')
  await execute(compiler, ['/nologo', '/target:exe', '/out:' + mainPath, waitingSource], { windowsHide: true })
  await execute(compiler, ['/nologo', '/target:winexe', '/out:' + join(f.program, '启动工作台.exe'), launcherSource], { windowsHide: true })
  const pin = async path => { const raw = await readFile(path); return { bytes: raw.length, sha256: sha(raw) } }
  const snapshot = await f.owner.capture()
  await writeFile(join(f.program, 'app/payload.bin'), 'new controlled generation')
  const generation = await f.owner.getCurrentGeneration(), expectedFingerprint = fingerprintEngineGeneration(generation)
  const children = []
  const closed = child => child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  const start = async () => {
    const child = spawn(mainPath, [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child)
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject) })
    return child
  }
  t.after(async () => { for (const child of children) { if (child.exitCode === null) child.stdin?.end('\n'); await closed(child) } })
  const main = await start(), service = await start(), identity = await worker.mainIdentity(main.pid)
  assert.equal(identity.exe.toLowerCase(), mainPath.toLowerCase())
  let observedExit = false
  const waiting = worker.waitForMainExit(identity).then(() => { observedExit = true })
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(observedExit, false)
  await assert.rejects(worker.assertTargetStopped(f.program, f.runtime), { code: 'engine_program_still_running' })
  main.stdin.end('\n'); assert.equal(await closed(main), 0); await waiting
  // Exact Main absence does not imply that a target-owned business service quit.
  await assert.rejects(worker.assertTargetStopped(f.program, f.runtime), { code: 'engine_program_still_running' })
  service.stdin.end('\n'); assert.equal(await closed(service), 0)
  await worker.assertTargetStopped(f.program, f.runtime)
  await f.owner.restoreStopped(snapshot.snapshotId, expectedFingerprint, f.runtime)
  const outcome = await f.owner.readRecoveryOutcome(expectedFingerprint)
  assert.deepEqual(outcome, { status: 'restored', safeToRestart: true })
  const request = { target: f.program, expectedFingerprint, launcher: await pin(join(f.program, '启动工作台.exe')), launcherConfig: await pin(join(f.program, 'launcher.json')) }
  const reopened = await worker.reopenVerifiedProgram(request, f.owner, outcome, f.runtime)
  assert.equal(await closed(reopened), 0)
  assert.equal(await readFile(marker, 'utf8'), 'normal-reopen')
  await writeFile(join(f.program, 'app/payload.bin'), 'third-party after restore')
  await assert.rejects(worker.reopenVerifiedProgram(request, f.owner, outcome, f.runtime), { code: 'engine_recovery_owner_changed' })
  t.diagnostic(JSON.stringify({ controlledMainPID: main.pid, exactCreation: identity.creation, normalMainExit: 0, controlledServicePID: service.pid, normalServiceExit: 0, normalReopenPID: reopened.pid, normalReopenExit: 0, scope: 'controlled no-window fixture executables; actual worker methods + actual owner/CLI; not a DSH GUI restart' }))
})

test('actual recovery run validates its copied runtime, waits normal exit, restores and reopens once; unsafe launcher gets fixed failure feedback', { timeout: 240000 }, async t => {
  assert.ok(process.env.TL_SEVEN_TEST_ROOT && process.env.TL_SEVEN_RUNTIME_PINS, 'explicit private root and pinned test runtimes required')
  const retention = { keep: false }, f = await fixture(t, undefined, process.env.TL_SEVEN_TEST_ROOT, retention)
  const worker = createRequire(import.meta.url)(join(R, 'apps/tradeloom-launcher/engine-recovery-worker.cjs'))
  const runtimePins = JSON.parse(await readFile(process.env.TL_SEVEN_RUNTIME_PINS, 'utf8'))
  const pin = async file => { const raw = await readFile(file); return { bytes: raw.length, sha256: sha(raw) } }
  const node = runtimePins.find(row => row.kind === 'node'), python = runtimePins.find(row => row.kind === 'python')
  for (const row of [node, python]) assert.deepEqual(await pin(row.path), { bytes: row.bytes, sha256: row.sha256 })
  assert.equal(process.execPath.toLowerCase(), node.path.replaceAll('/', '\\').toLowerCase())
  const relativeRoot = 'resources/tradeloom/recovery-fixture', capsule = join(f.program, 'app', relativeRoot)
  await mkdir(join(capsule, 'runtime/node'), { recursive: true }); await copyFile(node.path, join(capsule, 'runtime/node/node.exe'))
  const pythonRoot = dirname(python.path), pythonOut = join(capsule, 'runtime/python'); await mkdir(pythonOut)
  for (const name of ['python.exe', 'python3.dll', 'python312.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
    try { await copyFile(join(pythonRoot, name), join(pythonOut, name)) } catch (error) { if (error.code !== 'ENOENT' || ['python.exe', 'python312.dll'].includes(name)) throw error }
  }
  await cp(join(pythonRoot, 'Lib'), join(pythonOut, 'Lib'), { recursive: true, filter: path => !path.split(/[\\/]/).some(part => ['site-packages', '__pycache__'].includes(part)) })
  await cp(join(pythonRoot, 'DLLs'), join(pythonOut, 'DLLs'), { recursive: true })
  const program = JSON.parse(await readFile(join(R, 'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/program-recipe.json'), 'utf8'))
  for (const source of program.engineRecovery.sources) { const target = join(capsule, 'tools', source); await mkdir(dirname(target), { recursive: true }); await copyFile(join(R, source), target) }
  const files = []
  async function inventory(root, prefix = '') { for (const name of (await readdir(root)).sort()) { const relative = prefix ? prefix + '/' + name : name, full = join(root, name), info = await lstat(full); assert.equal(info.isSymbolicLink(), false); if (info.isDirectory()) await inventory(full, relative); else { assert.equal(info.isFile(), true); files.push({ source: 'app/' + relativeRoot + '/' + relative, path: relative, ...await pin(full) }) } } }
  await inventory(capsule)
  const recoveryResources = { schemaVersion: 1, files, node: 'runtime/node/node.exe', python: 'runtime/python/python.exe',
    worker: 'tools/apps/tradeloom-launcher/engine-recovery-worker.cjs', owner: 'tools/packages/tradeloom-shell/engine-generation-owner.js',
    validator: 'tools/apps/tradeloom-launcher/installed-bootstrap.mjs', cli: 'tools/scripts/apply-dsh-candidate.py' }
  const compiler = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), mainPath = join(f.program, 'app/controlled-main.exe')
  const marker = join(f.root, 'reopen-pid.txt'), waitSource = join(f.root, 'Wait.cs'), reopenSource = join(f.root, 'Reopen.cs')
  await writeFile(waitSource, 'using System;class Wait{static void Main(){Console.WriteLine("waiting");Console.ReadLine();}}')
  await writeFile(reopenSource, 'using System.IO;using System.Diagnostics;class Reopen{static void Main(){File.WriteAllText(@"' + marker.replaceAll('"', '""') + '",Process.GetCurrentProcess().Id.ToString());}}')
  await execute(compiler, ['/nologo', '/target:exe', '/out:' + mainPath, waitSource], { windowsHide: true })
  await execute(compiler, ['/nologo', '/target:winexe', '/out:' + join(f.program, '启动工作台.exe'), reopenSource], { windowsHide: true })
  const owner = await createEngineGenerationOwner({ programRoot: f.program, env: { DSH_HOME: f.home, TRADELOOM_DSH_APP_HOME: f.home }, validation, recoveryResources })
  const children = [], closed = child => child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  async function startMain() { const child = spawn(mainPath, [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child); await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject) }); return child }
  async function waitJson(file, predicate) { const until = Date.now() + 30000; while (Date.now() < until) { try { const value = JSON.parse(await readFile(file, 'utf8')); if (predicate(value)) return value } catch (error) { if (!['ENOENT'].includes(error.code)) throw error } await new Promise(resolve => setTimeout(resolve, 20)) } assert.fail('controlled worker phase not reached') }
  const results = []; let succeeded = false
  try {
    const snapshot = await owner.capture()
    for (const mode of ['normal', 'changed-launcher']) {
      if (mode === 'normal') await writeFile(join(f.program, 'app/payload.bin'), mode + ' controlled current generation')
      // The first restore's real pre-restore backup supplies the second target;
      // do not forge/delete an activation revision to manufacture a new one.
      const selected = mode === 'normal' ? snapshot : (await owner.list()).snapshots.find(row => row.kind === 'pre-restore-backup' && row.generationId !== snapshot.generationId)
      assert.ok(selected)
      const main = await startMain(), identity = await worker.mainIdentity(main.pid)
      const preview = await owner.previewRestore(selected.snapshotId), job = await owner.prepareWorker(preview.previewId, identity)
      const entry = join(dirname(job.requestPath), 'controlled-entry.cjs')
      // Execute the actual exported run(), with all real runtime/request checks,
      // state writes, owner, CLI and normal reopen. Only native MessageBox is
      // replaced by fixed test-owned feedback so no GUI is opened on failure.
      await writeFile(entry, "const fs=require('node:fs');const w=require(process.argv[2]);w.run(process.argv[3],process.argv[4],async restarted=>{fs.writeFileSync('feedback.json',JSON.stringify({kind:'fixed-recovery-error-feedback',restarted}));return true}).catch(()=>{process.stderr.write('engine_recovery_failed\\n');process.exitCode=1})")
      const child = spawn(job.node, [entry, job.worker, job.requestPath, job.requestSha256], { cwd: dirname(job.requestPath), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
      const resultPath = join(dirname(job.requestPath), 'result.json')
      await waitJson(resultPath, value => value.status === 'waiting-for-normal-exit')
      assert.equal(await readFile(join(f.program, 'app/payload.bin'), 'utf8'), mode === 'normal' ? 'normal controlled current generation' : 'old generation')
      if (mode === 'changed-launcher') await writeFile(join(f.program, '启动工作台.exe'), 'controlled third-party launcher; must not run')
      main.stdin.end('\n'); assert.equal(await closed(main), 0)
      const exit = await closed(child), result = JSON.parse(await readFile(resultPath, 'utf8'))
      t.diagnostic(JSON.stringify({ actualRunPhase: mode, workerExit: exit, result, fixedStderr: stderr }))
      if (mode === 'normal') {
        assert.equal(exit, 0, stderr); assert.equal(result.status, 'restored'); assert.equal(result.safeToRestart, true); assert.equal(result.restarted, true); assert.equal(result.failureCode, null)
        const until = Date.now() + 5000; let pid
        while (Date.now() < until) { try { pid = Number(await readFile(marker, 'utf8')); if (await worker.mainIdentity(pid) === null) break } catch (error) { if (error.code !== 'ENOENT') throw error } await new Promise(resolve => setTimeout(resolve, 20)) }
        assert.ok(pid > 0); assert.equal(await worker.mainIdentity(pid), null, 'controlled no-window normal launcher exited')
        results.push({ mode, workerPID: child.pid, workerExit: exit, mainPID: main.pid, mainCreation: identity.creation, mainExit: 0, reopenedPID: pid, reopenedPIDAbsent: true })
        await rm(marker)
      } else {
        assert.equal(exit, 1); assert.equal(stderr, 'engine_recovery_failed\n'); assert.equal(result.restarted, false); assert.equal(result.safeToRestart, false); assert.equal(result.failureCode, 'engine_recovery_readback_unknown')
        assert.deepEqual(JSON.parse(await readFile(join(dirname(job.requestPath), 'feedback.json'), 'utf8')), { kind: 'fixed-recovery-error-feedback', restarted: false })
        await assert.rejects(readFile(marker), { code: 'ENOENT' }); assert.equal(await readFile(join(f.program, '启动工作台.exe'), 'utf8'), 'controlled third-party launcher; must not run')
        results.push({ mode, workerPID: child.pid, workerExit: exit, mainPID: main.pid, mainCreation: identity.creation, mainExit: 0, noReopen: true, fixedFeedback: true })
      }
      assert.equal(await readFile(join(f.program, 'app/payload.bin'), 'utf8'), mode === 'normal' ? 'old generation' : 'normal controlled current generation'); assert.deepEqual(await readFile(join(f.program, 'launcher.json')), f.config)
    }
    t.diagnostic(JSON.stringify({ actualRun: results, runtimeFiles: files.length, scope: 'exact copied runtime + real run/request/CIM/FS/CLI; synthetic no-window executables; MessageBox controlled; not real DSH GUI recovery' }))
    succeeded = true
  } finally { for (const child of children) { if (child.exitCode === null) child.stdin?.end('\n'); await closed(child) } await owner.dispose(); if (!succeeded) { retention.keep = true; t.diagnostic(JSON.stringify({ retainedSyntheticRoot: f.root, scope: 'owned fixture only, not user data' })) } }
})
