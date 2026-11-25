#!/usr/bin/env node
// Regenerate the F2 cross-language corpus; review every diagnostic change.
import { readFileSync, writeFileSync } from 'node:fs'
import { checkView } from '../lib/view-check.js'

export function expected() {
  const cases = JSON.parse(readFileSync(new URL('../test/parity/controls-inputs.json', import.meta.url), 'utf8'))
  return `${JSON.stringify(Object.fromEntries(cases.map((c) => {
    const r = checkView(c.view, { budget: c.budget, data: c.data, lang: 'zh' })
    return [c.name, { fatal: r.fatal, title: r.title, issues: r.issues.map(({ path, message }) => ({ path, message })) }]
  })), null, 1)}\n`
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const target = new URL('../test/parity/controls-expected.json', import.meta.url)
  const text = expected()
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== text) { process.stderr.write('controls parity is out of date\n'); process.exit(1) }
  } else writeFileSync(target, text)
}
