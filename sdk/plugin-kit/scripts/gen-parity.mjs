#!/usr/bin/env node
// Regenerates test/parity/expected.json from test/parity/inputs.json with the JS twin
// (lib/view-check.js). The app's Dart parser must produce the same: the app-side parity
// test reads both files. Review every diff before committing: an unexpected change here
// means the twin no longer matches the app.
//
//   node scripts/gen-parity.mjs           write
//   node scripts/gen-parity.mjs --check   exit 1 when out of date
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkView } from '../lib/view-check.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'parity')

export function expected() {
  const inputs = JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8'))
  const out = {}
  for (const c of inputs) {
    const r = checkView(c.view, { budget: c.budget, data: c.data, lang: 'zh' })
    out[c.name] = { fatal: r.fatal, title: r.title, issues: r.issues.map(({ path, message, kind }) => ({ path, message, kind })) }
  }
  return `${JSON.stringify(out, null, 1)}\n`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = expected()
  const target = join(dir, 'expected.json')
  if (process.argv.includes('--check')) {
    let current = ''
    try { current = readFileSync(target, 'utf8') } catch {}
    if (current !== text) { process.stderr.write('test/parity/expected.json is out of date\n'); process.exit(1) }
  } else {
    writeFileSync(target, text)
    process.stdout.write(`wrote ${target}\n`)
  }
}
