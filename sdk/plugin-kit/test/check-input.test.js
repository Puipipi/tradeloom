import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { checkPlugin, exitCode, main } from '../lib/check.js'

const cliPath = fileURLToPath(new URL('../bin/check.mjs', import.meta.url))
const view = JSON.stringify({ type: 'text', text: 'A valid view' })
const cli = (args, input = view, cwd) => spawnSync(process.execPath, [cliPath, ...args], { input, cwd, encoding: 'utf8' })

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-check-input-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'plugin')
  mkdirSync(dir)
  writeFileSync(join(dir, 'patch.yml'), '')
  return { root, dir, write: value => writeFileSync(join(dir, 'package.json'), JSON.stringify(value)) }
}

const pkg = panels => ({ name: 'fixture', engines: { dsh: '*' }, dsh: { bundle: { patch: 'patch.yml' } }, dshGo: { v: 1, contributes: { panels } } })

test('non-object package JSON yields a readable report, including --json CLI', async t => {
  const f = fixture(t)
  for (const value of [null, [], 'text', 42, false]) {
    f.write(value)
    const report = await checkPlugin(f.dir, { lang: 'en' })
    assert.equal(exitCode(report), 3)
    assert.match(report.unreadable, /package\.json.*JSON object/)
    const r = cli([f.dir, '--json'])
    assert.equal(r.status, 3)
    assert.equal(r.stderr, '')
    assert.equal(JSON.parse(r.stdout).kind, 'plugin')
  }
})

test('malformed panels preserve bridge diagnostics instead of throwing', async t => {
  const f = fixture(t)
  for (const panels of [{}, true, 42, 'text']) {
    f.write(pkg(panels))
    const r = await checkPlugin(f.dir)
    assert.equal(exitCode(r), 1)
    assert.ok(r.manifest.issues.some(i => i.path === '/dshGo/contributes/panels' && i.code === 'invalid-field'))
    assert.deepEqual(r.views, [])
  }
})

test('checker does not parse a sibling-prefix path rejected by the bridge', async t => {
  const f = fixture(t)
  const sibling = join(f.root, 'plugin-outside')
  mkdirSync(sibling)
  writeFileSync(join(sibling, 'view.json'), '{"type":"not-a-component"}')
  f.write(pkg([{ id: 'outside', title: 'Outside', placement: ['features'], view: '../plugin-outside/view.json' }]))
  const r = await checkPlugin(f.dir)
  assert.ok(r.manifest.issues.some(i => i.code === 'view-file'))
  assert.deepEqual(r.views, [], 'rejected file must not become an app-side view report')
  writeFileSync(join(f.dir, 'view.json'), view)
  f.write(pkg([{ id: 'inside', title: 'Inside', placement: ['features'], view: './view.json' }]))
  const normal = await checkPlugin(f.dir)
  assert.equal(exitCode(normal), 0)
  assert.equal(normal.views.length, 1)
})

test('checker does not parse a symlink rejected by the bridge', async t => {
  const f = fixture(t)
  const sibling = join(f.root, 'plugin-outside')
  mkdirSync(sibling)
  writeFileSync(join(sibling, 'view.json'), '{"type":"not-a-component"}')
  try {
    symlinkSync(join(sibling, 'view.json'), join(f.dir, 'link.json'))
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
    t.skip('Windows did not permit creating the symlink (EPERM)')
    return
  }
  f.write(pkg([{ id: 'outside', title: 'Outside', placement: ['features'], view: 'link.json' }]))
  const r = await checkPlugin(f.dir)
  assert.ok(r.manifest.issues.some(i => i.code === 'view-file'))
  assert.deepEqual(r.views, [], 'rejected file must not become an app-side view report')
})

test('missing option values and prototype names produce argument diagnostics', () => {
  for (const args of [
    ['-', '--budget'], ['-', '--lang'], ['-', '--app'],
    ['-', '--budget='], ['-', '--lang='], ['-', '--app='],
    ['-', '--budget', 'constructor'], ['-', '--budget', '__proto__'],
    ['-', '--budget', 'toString'], ['-', '--budget', '--json'],
    ['-', '--lang', 'fr'], ['-', '--app', 'v1.2.3'], ['-', '--unknown'],
  ]) {
    const r = cli(args)
    assert.equal(r.status, 3, JSON.stringify(args))
    assert.equal(r.stderr, '')
    assert.match(r.stdout, /--(?:budget|lang|app|unknown)/)
    assert.doesNotMatch(r.stdout, /undefined/)
  }
})

test('argument failure with --json stays machine-readable', () => {
  const r = cli(['-', '--json', '--budget', 'constructor'])
  assert.equal(r.status, 3)
  const report = JSON.parse(r.stdout)
  assert.equal(report.kind, 'arguments')
  assert.match(report.unreadable, /--budget/)
})

test('option terminator permits a filename beginning with --', t => {
  const f = fixture(t)
  writeFileSync(join(f.dir, '--view.json'), view)
  const r = cli(['--', '--view.json'], '', f.dir)
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '')
  assert.match(r.stdout, /--view\.json/)
})

test('unreadable stdin reports exit 3 and continues to a later valid target', async t => {
  const f = fixture(t)
  const path = join(f.dir, 'view.json')
  writeFileSync(path, view)
  let output = ''
  const status = await main(['-', path, '--json'], { stdin: -1, stdout: { write: s => { output += s } } })
  assert.equal(status, 3)
  const reports = JSON.parse(output)
  assert.equal(reports.length, 2)
  assert.ok(reports[0].unreadable)
  assert.equal(exitCode(reports[1]), 0)
})

test('multiple targets and normal named options retain existing behavior', t => {
  const f = fixture(t)
  const path = join(f.dir, 'view.json')
  writeFileSync(path, view)
  const r = cli(['-', path, '--budget=panel', '--lang=en', '--app=1.2.3', '--json'])
  assert.equal(r.status, 0)
  assert.deepEqual(JSON.parse(r.stdout).map(x => x.views[0].budget), ['panel', 'panel'])
})
