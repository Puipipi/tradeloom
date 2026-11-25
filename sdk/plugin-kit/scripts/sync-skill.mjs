#!/usr/bin/env node
// Builds the app's bundled skill app/assets/skills/dsh-go-plugin/ from skill/ (SKILL.md and the
// plugin template) and the checker (bin/check.mjs, lib/, schema/). Flutter bundles a flat asset
// directory, so each file is stored under a flat name and manifest.json maps it to its place in
// the installed skill folder ($DSH_HOME/skills/dsh-go-plugin/…), like the dsh-go-ui skill.
//
//   node scripts/sync-skill.mjs           write
//   node scripts/sync-skill.mjs --check   exit 1 when out of date
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const kit = join(here, '..')
export const SKILL_DIR = join(kit, '..', '..', 'app', 'assets', 'skills', 'dsh-go-plugin')

/** target path inside the installed skill → source file. */
export function sources() {
  const out = { 'SKILL.md': join(kit, 'skill', 'SKILL.md') }
  for (const f of ['package.json', 'cordis.patch.yml', 'lib/index.js']) out[`template/${f}`] = join(kit, 'skill', 'template', f)
  out['kit/bin/check.mjs'] = join(kit, 'bin', 'check.mjs')
  for (const f of ['check.js', 'view-check.js', 'style-check.js', 'controls-check.js', 'formula.js', 'messages.json', 'testing.js', 'json-schema.js']) out[`kit/lib/${f}`] = join(kit, 'lib', f)
  for (const f of ['limits.js', 'util.js', 'effects.js', 'manifest.js', 'capabilities.js']) out[`kit/lib/bridge/${f}`] = join(kit, 'lib', 'bridge', f)
  for (const f of readdirSync(join(kit, 'schema')).filter((f) => f.endsWith('.schema.json')).sort()) out[`kit/schema/${f}`] = join(kit, 'schema', f)
  return out
}

const assetName = (target) => target.replaceAll('/', '-')

/** asset file name → content, manifest.json included. */
export function render() {
  const files = {}
  const map = {}
  for (const [target, src] of Object.entries(sources())) {
    const name = assetName(target)
    files[name] = readFileSync(src, 'utf8')
    map[name] = target
  }
  files['manifest.json'] = `${JSON.stringify({ name: 'dsh-go-plugin', files: map }, null, 2)}\n`
  return files
}

export function stale() {
  const want = render()
  const have = existsSync(SKILL_DIR) ? readdirSync(SKILL_DIR) : []
  const out = Object.keys(want).filter((n) => !existsSync(join(SKILL_DIR, n)) || readFileSync(join(SKILL_DIR, n), 'utf8') !== want[n])
  out.push(...have.filter((n) => !(n in want)).map((n) => `${n} (extra)`))
  return out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const s = stale()
    if (s.length) {
      process.stderr.write(`app/assets/skills/dsh-go-plugin is out of date: ${s.join(', ')} — run node scripts/sync-skill.mjs\n`)
      process.exit(1)
    }
  } else {
    const files = render()
    mkdirSync(SKILL_DIR, { recursive: true })
    for (const n of readdirSync(SKILL_DIR)) if (!(n in files)) rmSync(join(SKILL_DIR, n))
    for (const [n, text] of Object.entries(files)) writeFileSync(join(SKILL_DIR, n), text)
    process.stdout.write(`wrote ${Object.keys(files).length} files into ${SKILL_DIR}\n`)
  }
}
