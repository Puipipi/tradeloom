import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const runtime = process.env.TRADELOOM_DSH_RUNTIME
  ?? 'C:\\Users\\23825\\Desktop\\ICT\\workspace\\runtime\\tradeloom-harness\\releases\\0.2.1-rc.3-tradeloom-desktop-16'
const electron = join(runtime, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
const typescript = createRequire(import.meta.url)(join(runtime, 'node_modules', 'typescript', 'lib', 'typescript.js'))

function runElectron(mainFile, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electron, [mainFile], { env, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Electron fixture timed out: ${stderr.slice(-1500)}`)) }, 30_000)
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      const line = stdout.split(/\r?\n/).find(row => row.startsWith('DIAGNOSTICS_RESULT='))
      if (code !== 0 || !line) { reject(new Error(`Electron fixture exit ${code}: ${stderr.slice(-2000)}\n${stdout.slice(-1000)}`)); return }
      try { resolvePromise(JSON.parse(line.slice('DIAGNOSTICS_RESULT='.length))) }
      catch (error) { reject(error) }
    })
  })
}

test('真实受控 Electron DOM：仅返回安全元数据，导航/异站/销毁明确失败', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'tradeloom-ai-diag-'))
  t.after(async () => {
    await rm(temp, { recursive: true, force: true })
  })

  const [source, ts] = await Promise.all([
    readFile(join(here, 'diagnostics.ts'), 'utf8'), Promise.resolve(typescript),
  ])

  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const modulePath = join(temp, 'diagnostics.cjs')
  await writeFile(modulePath, compiled, 'utf8')
  const report = await runElectron(join(here, 'fixtures', 'diagnostics-electron-main.cjs'), {
    ...process.env,
    DIAGNOSTICS_MODULE: modulePath,
    DIAGNOSTICS_USER_DATA: join(temp, 'electron-user-data'),
    DIAGNOSTICS_FIXTURE_HTML: join(here, 'fixtures', 'diagnostics.html'),
  })

  assert.equal(report.fixtureOrigin, 'https://chat.deepseek.com')
  assert.equal(report.cookieCanaryVerified, true)
  assert.equal(report.noCanary, true)
  assert.equal(report.success.provider, 'doubao')
  assert.equal(report.success.origin, 'https://www.doubao.com')
  assert.equal(report.success.inputPresent, true)
  assert.equal(report.success.loginRequired, true)
  assert.equal(report.success.draftState, 'unknown')
  assert.equal(report.success.generationState, 'unknown')
  assert.equal(report.success.candidateListComplete, true)
  assert.ok(report.success.messageIdentityAttributes.some(item => item.name === 'data-message-id' && item.present))
  assert.ok(report.success.messageIdentityAttributes.some(item => item.name === 'data-turn-id' && item.present))
  assert.equal(report.success.candidates.some(item => item.testId === 'private-side-button-canary'), false)
  assert.equal(report.success.candidates.some(item => item.hasLabel), true)
  assert.equal(report.success.candidates.some(item => item.ariaLabel === 'ARIA_LABEL_CANARY'), false)
  assert.equal(report.success.candidates.some(item => item.ariaLabel === 'Send'), true)
  assert.equal(report.wrongOrigin.code, 'unsupported-origin')
  assert.equal(report.navigation.code, 'document-changed')
  assert.equal(report.afterDestroy.code, 'window-destroyed')
  assert.doesNotMatch(JSON.stringify(report), /CANARY/)
})
