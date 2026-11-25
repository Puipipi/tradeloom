#!/usr/bin/env node
// Copies the app's wording for view problems (app/lib/l10n/parts/{view,plugview}_{zh,en}.arb)
// into lib/messages.json, so `check` says exactly what the app's plugin details page says.
//
//   node scripts/sync-messages.mjs           write
//   node scripts/sync-messages.mjs --check   exit 1 when out of date
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const ARB_DIR = join(here, '..', '..', '..', 'app', 'lib', 'l10n', 'parts')
export const TARGET = join(here, '..', 'lib', 'messages.json')
const EXTRA = ['viewListSeparator', 'viewLabeledValue', 'viewSemicolonSeparator', 'commonConfirm', 'commonCancel']

const params = {}

function read(locale) {
  const out = {}
  for (const [part, prefixes] of [['view', ['viewUi']], ['plugview', ['plugView']], ['plugin_controls', ['plugInput']], ['common', []]]) {
    const file = join(ARB_DIR, `${part}_${locale}.arb`)
    const arb = JSON.parse(readFileSync(file, 'utf8'))
    for (const [k, v] of Object.entries(arb)) {
      if (k.startsWith('@') || typeof v !== 'string') continue
      if (!prefixes.some((p) => k.startsWith(p)) && !EXTRA.includes(k)) continue
      out[k] = v
      // Positional order of the generated Dart method = declaration order of the placeholders.
      const names = Object.keys(arb[`@${k}`]?.placeholders ?? {})
      if (names.length > 0) params[k] = names
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function render() {
  const zh = read('zh')
  const en = read('en')
  const sorted = Object.fromEntries(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return `${JSON.stringify({ zh, en, params: sorted }, null, 1)}\n`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(ARB_DIR)) {
    process.stderr.write(`no app sources at ${ARB_DIR}\n`)
    process.exit(2)
  }
  const text = render()
  if (process.argv.includes('--check')) {
    const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : ''
    if (current !== text) {
      process.stderr.write('lib/messages.json is out of date: run node scripts/sync-messages.mjs\n')
      process.exit(1)
    }
  } else {
    writeFileSync(TARGET, text)
    process.stdout.write(`wrote ${TARGET}\n`)
  }
}
