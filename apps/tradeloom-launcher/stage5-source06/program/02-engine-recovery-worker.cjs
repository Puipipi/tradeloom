// This worker is copied and hash-verified outside both target/ and transaction/
// before Main starts it. It only runs a fixed owned request after normal exit.
'use strict'
const fs = require('node:fs/promises')
const { createReadStream } = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFile, spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { promisify } = require('node:util')
const execute = promisify(execFile)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (root, file) => { const part = path.relative(path.resolve(root), path.resolve(file)); return part === '' || (part !== '..' && !part.startsWith('..' + path.sep) && !path.isAbsolute(part)) }
async function notifyFailure(restarted) {
  const system = process.env.SystemRoot
  if (!system || !path.isAbsolute(system)) return false
  const message = restarted ? '引擎恢复发生错误。已按完整程序及归属读回安全重开；恢复记录和回滚点已保留。' : '引擎恢复未确认，未盲目重开程序。恢复记录、锁及回滚点已保留，请核对受控恢复记录后处理。'
  const script = "Add-Type -AssemblyName System.Windows.Forms;[void][System.Windows.Forms.MessageBox]::Show($env:TRADELOOM_RECOVERY_MESSAGE,'TradeLoom 引擎恢复',[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Error)"
  try { await execute(path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, env: { ...process.env, TRADELOOM_RECOVERY_MESSAGE: message } }); return true } catch { return false }
}
async function ordinary(file) {
  for (let cursor = path.resolve(file); ; cursor = path.dirname(cursor)) {
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw Error('recovery worker refuses reparse paths')
    if (path.dirname(cursor) === cursor) break
  }
}
async function pin(file) {
  await ordinary(file)
  const info = await fs.lstat(file)
  if (!info.isFile()) throw Error('recovery worker requires ordinary files')
  const digest = createHash('sha256'); for await (const bytes of createReadStream(file)) digest.update(bytes)
  return { bytes: info.size, sha256: digest.digest('hex') }
}
async function mainIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('invalid Main identity')
  const system = process.env.SystemRoot
  if (!system || !path.isAbsolute(system)) throw Error('system runtime unavailable')
  const script = "$ErrorActionPreference='Stop';Import-Module (Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1') -ErrorAction Stop;$p=Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "';if($null -eq $p){[Console]::Out.Write('null')}else{[Console]::Out.Write((@{pid=[int]$p.ProcessId;exe=$p.ExecutablePath;creation=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress))}"
  const result = await execute(path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', maxBuffer: 8192 })
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''))
}
async function waitForMainExit(main) {
  const deadline = Date.now() + 120_000
  while (true) {
    const current = await mainIdentity(main.pid)
    if (!current || current.creation !== main.creation) return
    if (current.exe.toLowerCase() !== main.exe.toLowerCase()) throw Error('Main PID identity changed')
    if (Date.now() >= deadline) throw Object.assign(Error('engine_main_still_running'), { code: 'engine_main_still_running' })
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}
async function assertTargetStopped(target, runtime) {
  // Reuse the same real CIM/ExecutablePath owner check as apply, without an
  // update or broadening its authority. The worker itself is outside target.
  const probe = "import importlib.util,sys;from pathlib import Path;sys.dont_write_bytecode=True;s=importlib.util.spec_from_file_location('owned_apply',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);sys.exit(12 if m.owned_processes([Path(sys.argv[2])]) else 0)"
  // Only the pinned private CLI filename changes representation. Python imports
  // its sibling modules through __file__; target identity remains unchanged.
  try { await execute(runtime.python, ['-B', '-c', probe, path.toNamespacedPath(path.resolve(runtime.cli)), target], { windowsHide: true, maxBuffer: 8192 }) }
  catch (error) { throw Object.assign(Error('engine_program_not_stopped'), { code: error.code === 12 ? 'engine_program_still_running' : 'engine_stop_inspection_failed' }) }
}
async function reopenVerifiedProgram(request, owner, expectedOutcome, runtime) {
  await assertTargetStopped(request.target, runtime)
  const final = await owner.readRecoveryOutcome(request.expectedFingerprint)
  if (!final.safeToRestart || final.status !== expectedOutcome.status) throw Object.assign(Error('engine_recovery_owner_changed'), { code: 'engine_recovery_owner_changed' })
  const launcher = path.join(request.target, '启动工作台.exe')
  if (JSON.stringify(await pin(launcher)) !== JSON.stringify(request.launcher)
    || JSON.stringify(await pin(path.join(request.target, 'launcher.json'))) !== JSON.stringify(request.launcherConfig)) throw Object.assign(Error('engine_recovery_launcher_changed'), { code: 'engine_recovery_launcher_changed' })
  const child = spawn(launcher, [], { cwd: request.target, detached: true, windowsHide: false, shell: false, stdio: 'ignore' })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  return child
}
async function run(requestPath, expectedHash, failureFeedback = notifyFailure) {
  if (typeof failureFeedback !== 'function') throw Error('invalid recovery feedback')
  await ordinary(requestPath)
  const bytes = await fs.readFile(requestPath)
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || hash(bytes) !== expectedHash) throw Error('owned recovery request changed')
  const request = JSON.parse(bytes)
  const keys = ['schemaVersion', 'target', 'directory', 'main', 'files', 'runtime', 'snapshotId', 'expectedFingerprint', 'home', 'launcher', 'launcherConfig']
  if (Object.keys(request).length !== keys.length || keys.some(key => !Object.hasOwn(request, key)) || request.schemaVersion !== 1
    || path.dirname(path.resolve(requestPath)) !== path.resolve(request.directory) || inside(request.target, request.directory)
    || !Array.isArray(request.files) || !request.files.length || !inside(path.join(request.target, 'app'), request.main.exe)) throw Error('invalid owned recovery request')
  const resolveRuntime = key => {
    const result = path.resolve(request.directory, request.runtime[key])
    if (!inside(request.directory, result) || !request.files.some(row => path.resolve(request.directory, row.path) === result)) throw Error('unverified recovery runtime')
    return result
  }
  if (process.execPath.toLowerCase() !== resolveRuntime('node').toLowerCase() || __filename.toLowerCase() !== resolveRuntime('worker').toLowerCase()) throw Error('recovery ran outside its pinned runtime')
  for (const row of request.files) {
    const file = path.resolve(request.directory, row.path)
    if (!inside(request.directory, file) || JSON.stringify(await pin(file)) !== JSON.stringify({ bytes: row.bytes, sha256: row.sha256 })) throw Error('recovery runtime drift')
  }
  async function saveResult(value, first = false) {
    await ordinary(request.directory)
    const resultPath = path.join(request.directory, 'result.json')
    if (first) await fs.writeFile(resultPath, JSON.stringify(value) + '\n', { flag: 'wx' })
    else {
      const next = path.join(request.directory, 'result.next.json')
      await fs.writeFile(next, JSON.stringify(value) + '\n', { flag: 'wx' })
      await fs.rename(next, resultPath)
    }
  }
  let phase = 'wait-main', failureCode = null, owner, restarted = false
  let outcome = { status: 'unknown', safeToRestart: false }
  await saveResult({ schemaVersion: 1, status: 'waiting-for-normal-exit', phase, restarted: false }, true)
  try {
    // A timeout never gives permission to force-close. CLI independently checks
    // every target/work executable again after exact Main has exited.
    await waitForMainExit(request.main)
    phase = 'verify-runtime'
    for (const row of request.files) if (JSON.stringify(await pin(path.resolve(request.directory, row.path))) !== JSON.stringify({ bytes: row.bytes, sha256: row.sha256 })) throw Error('recovery runtime changed while waiting')
    const runtime = { node: resolveRuntime('node'), python: resolveRuntime('python'), cli: resolveRuntime('cli') }
    await assertTargetStopped(request.target, runtime)
    const validation = await import(pathToFileURL(resolveRuntime('validator')).href)
    const { createEngineGenerationOwner } = await import(pathToFileURL(resolveRuntime('owner')).href)
    owner = await createEngineGenerationOwner({ programRoot: request.target, env: request.home, validation })
    phase = 'restore'
    try { await owner.restoreStopped(request.snapshotId, request.expectedFingerprint, runtime) }
    catch (error) { failureCode = /^engine_[a-z_]+$/.test(error?.code ?? '') ? error.code : 'engine_recovery_failed' }
    phase = 'readback'
    outcome = await owner.readRecoveryOutcome(request.expectedFingerprint)
    const launcher = path.join(request.target, '启动工作台.exe')
    const launcherSafe = JSON.stringify(await pin(launcher)) === JSON.stringify(request.launcher)
      && JSON.stringify(await pin(path.join(request.target, 'launcher.json'))) === JSON.stringify(request.launcherConfig)
    if (!launcherSafe || !outcome.safeToRestart) { outcome = { status: 'unknown', safeToRestart: false }; failureCode ??= 'engine_recovery_readback_unknown' }
    if (outcome.safeToRestart) {
      // Recheck the full owner/payload immediately before the one normal reopen.
      phase = 'restart'
      const child = await reopenVerifiedProgram(request, owner, outcome, runtime)
      child.unref(); restarted = true
    }
  } catch (error) { outcome = { status: 'unknown', safeToRestart: false }; failureCode ??= /^engine_[a-z_]+$/.test(error?.code ?? '') ? error.code : 'engine_recovery_failed' }
  finally { try { await owner?.dispose() } catch { failureCode ??= 'engine_recovery_cleanup_failed' } }
  await saveResult({ schemaVersion: 1, ...outcome, phase, failureCode, restarted })
  if (failureCode) {
    // Visible, fixed failure feedback even when no payload is safe to launch.
    // No raw errors, paths, drafts or request content enter this message.
    await failureFeedback(restarted)
    throw Object.assign(Error('engine_recovery_failed'), { code: 'engine_recovery_failed', feedbackAttempted: true })
  }
}
if (require.main === module) run(process.argv[2], process.argv[3]).catch(async error => {
  // Only a fixed failure class is emitted; no program paths, request or data.
  process.stderr.write('engine_recovery_failed\n')
  if (!error.feedbackAttempted) await notifyFailure(false)
  process.exitCode = 1
})
module.exports = { run, mainIdentity, waitForMainExit, assertTargetStopped, reopenVerifiedProgram }
