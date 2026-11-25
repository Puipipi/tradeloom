#!/usr/bin/env node
// Copies the bridge's pure manifest / effect modules into lib/bridge/ so
// `check` and the test host report exactly what the bridge reports. The
// files are copied byte for byte; test/sync.test.js fails when they
// drift from runtime/bridge/dsh-go-bridge/lib/native/.
//
//   node scripts/sync-bridge.mjs           copy
//   node scripts/sync-bridge.mjs --check   exit 1 when out of date
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const BRIDGE_DIR = join(here, '..', '..', '..', 'runtime', 'bridge', 'dsh-go-bridge', 'lib', 'native')
export const VENDOR_DIR = join(here, '..', 'lib', 'bridge')
export const VENDORED = ['limits.js', 'util.js', 'effects.js', 'manifest.js', 'capabilities.js']

export function staleFiles() {
  return VENDORED.filter((f) => {
    const src = join(BRIDGE_DIR, f)
    const dst = join(VENDOR_DIR, f)
    return !existsSync(dst) || !readFileSync(src).equals(readFileSync(dst))
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(BRIDGE_DIR)) {
    process.stderr.write(`no bridge sources at ${BRIDGE_DIR}\n`)
    process.exit(2)
  }
  const stale = staleFiles()
  if (process.argv.includes('--check')) {
    if (stale.length > 0) {
      process.stderr.write(`lib/bridge is out of date: ${stale.join(', ')} — run node scripts/sync-bridge.mjs\n`)
      process.exit(1)
    }
  } else {
    mkdirSync(VENDOR_DIR, { recursive: true })
    for (const f of VENDORED) copyFileSync(join(BRIDGE_DIR, f), join(VENDOR_DIR, f))
    process.stdout.write(`copied ${VENDORED.length} files into ${VENDOR_DIR}${stale.length ? ` (changed: ${stale.join(', ')})` : ''}\n`)
  }
}
