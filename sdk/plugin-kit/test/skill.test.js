// The bundled skill (app/assets/skills/dsh-go-plugin): in sync with the kit, and working once
// laid out the way the app installs it ($DSH_HOME/skills/dsh-go-plugin/…).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { SKILL_DIR, render, stale } from '../scripts/sync-skill.mjs'

test('app/assets/skills/dsh-go-plugin matches the kit', { skip: existsSync(dirname(SKILL_DIR)) ? false : 'no app/ checkout' }, () => {
  assert.deepEqual(stale(), [], 'run node scripts/sync-skill.mjs')
})

test('SKILL.md: front matter first, managed line inside it', () => {
  const md = render()['SKILL.md']
  assert.match(md, /^---\n# dsh-go:managed — /)
  assert.match(md, /\nname: dsh-go-plugin\n/)
})

test('installed layout: the checker runs and the template passes with --load', () => {
  const home = mkdtempSync(join(tmpdir(), 'skill-'))
  try {
    const files = render()
    const map = JSON.parse(files['manifest.json']).files
    const skill = join(home, 'skills', 'dsh-go-plugin')
    for (const [asset, target] of Object.entries(map)) {
      mkdirSync(dirname(join(skill, target)), { recursive: true })
      writeFileSync(join(skill, target), files[asset])
    }
    const plugin = join(home, 'dsh-go', 'plugins', 'local-quote')
    mkdirSync(dirname(plugin), { recursive: true })
    cpSync(join(skill, 'template'), plugin, { recursive: true })
    const r = spawnSync(process.execPath, [join(skill, 'kit', 'bin', 'check.mjs'), plugin, '--load'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^local-my-plugin 0\.1\.0\n {2}原生界面能显示（胶囊 1）\n {2}已加载宿主半侧：1 项可用/)
    const bad = spawnSync(process.execPath, [join(skill, 'kit', 'bin', 'check.mjs'), '-'], { encoding: 'utf8', input: '{"type":"metric","label":"x"}' })
    assert.equal(bad.status, 2)
    assert.match(bad.stdout, /整块无法显示：view\.value：应该是字符串或数字/)
    assert.ok(!readFileSync(join(plugin, 'package.json'), 'utf8').includes('dsh-go-example'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
